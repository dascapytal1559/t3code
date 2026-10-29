import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import type { SidebarSection } from "../Sidebar.logic";

/**
 * The coordinator a thread names, if any. A coordinator is an unarchived thread some thread names
 * (it may name itself); its crew are the other unarchived threads naming it. The sidebar lists
 * both above Pinned and keeps them out of Working.
 */
export type CoordinatorOf<T> = (thread: T) => ThreadId | null;

type GroupThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedAt">;

export interface CoordinatorGroup<T> {
  readonly coordinators: ReadonlySet<T>;
  readonly crew: ReadonlySet<T>;
}

const NO_GROUP: CoordinatorGroup<never> = { coordinators: new Set(), crew: new Set() };

const threadKey = (thread: GroupThread) => `${thread.environmentId}:${thread.id}`;

export function resolveCoordinatorGroup<T extends GroupThread>(
  threads: readonly T[],
  coordinatorOf: CoordinatorOf<T>,
): CoordinatorGroup<T> {
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread] as const));
  const coordinators = new Set<T>();
  const crew = new Set<T>();
  for (const thread of threads) {
    const coordinatorId = coordinatorOf(thread);
    if (coordinatorId === null) continue;
    const coordinator = byKey.get(`${thread.environmentId}:${coordinatorId}`);
    if (coordinator === undefined || coordinator.archivedAt !== null) continue;
    coordinators.add(coordinator);
    if (thread !== coordinator && thread.archivedAt === null) crew.add(thread);
  }
  if (coordinators.size === 0) return NO_GROUP;
  // A coordinator that is itself crew, such as a FirstMate secondmate, stays with its crewmates.
  for (const member of crew) coordinators.delete(member);
  return { coordinators, crew };
}

/** The only coordinator, if there is one; its card needs no title to tell it apart. */
export function soleCoordinator<T>(group: CoordinatorGroup<T>): T | null {
  if (group.coordinators.size !== 1) return null;
  const [only] = group.coordinators;
  return only ?? null;
}

/**
 * Where a thread the sidebar would otherwise list in `section` goes instead, if anywhere. It runs
 * before the Working split, so neither ever reaches Working. Snoozing or settling is the way out
 * of the group; pinning changes nothing because the group already sits above Pinned.
 */
export function coordinatorGroupSlot<T>(
  group: CoordinatorGroup<T>,
  thread: T,
  section: SidebarSection,
): "coordinator" | "crew" | null {
  if (section === "snoozed" || section === "settled") return null;
  if (group.coordinators.has(thread)) return "coordinator";
  return group.crew.has(thread) ? "crew" : null;
}

type FirstMateThread = GroupThread &
  Pick<EnvironmentThreadShell, "projectId" | "title" | "worktreePath" | "createdAt"> & {
    readonly source: Pick<EnvironmentThreadShell["source"], "createdBy" | "creationSource">;
  };

type FirstMateProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

const FIRSTMATE = "firstmate";

const trimSeparators = (path: string) => path.replace(/[\\/]+$/, "");

/**
 * A FirstMate home is a clone of the FirstMate repository: its root, not a folder inside it,
 * found by repository or folder name.
 */
function isFirstMateHome(project: FirstMateProject): boolean {
  const root = trimSeparators(project.workspaceRoot);
  const identity = project.repositoryIdentity;
  if (
    identity?.name?.toLowerCase() === FIRSTMATE &&
    (identity.rootPath === undefined || trimSeparators(identity.rootPath) === root)
  ) {
    return true;
  }
  return root.slice(Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\")) + 1) === FIRSTMATE;
}

/** FirstMate launches every crewmate over MCP and titles it `fm-<task-id>`. */
function isFirstMateCrewmate(thread: FirstMateThread): boolean {
  return (
    thread.source.creationSource === "mcp" &&
    thread.source.createdBy === "agent" &&
    thread.title.startsWith("fm-")
  );
}

/**
 * Infers the coordinator link FirstMate cannot yet record, since T3 stores nothing about which
 * session launched a thread. The main session is the newest unarchived thread in a FirstMate
 * home that runs in the home itself rather than a worktree and is not a crewmate, as FirstMate's
 * own discovery finds it. It names itself, so it stays on top before its first crewmate.
 */
export function inferFirstMateCoordinatorOf<T extends FirstMateThread>(
  threads: readonly T[],
  projects: readonly FirstMateProject[],
): CoordinatorOf<T> {
  const homes = new Set(
    projects.filter(isFirstMateHome).map((project) => `${project.environmentId}:${project.id}`),
  );
  let main: T | null = null;
  if (homes.size > 0) {
    for (const thread of threads) {
      if (
        thread.archivedAt === null &&
        thread.worktreePath === null &&
        homes.has(`${thread.environmentId}:${thread.projectId}`) &&
        !isFirstMateCrewmate(thread) &&
        (main === null || thread.createdAt > main.createdAt)
      ) {
        main = thread;
      }
    }
  }
  if (main === null) return () => null;
  const coordinator = main;
  return (thread) =>
    thread === coordinator ||
    (thread.environmentId === coordinator.environmentId && isFirstMateCrewmate(thread))
      ? coordinator.id
      : null;
}

/** The coordinator group the app shows and opens; the one place its coordinator link is read. */
export function resolveAppCoordinatorGroup<T extends FirstMateThread>(
  threads: readonly T[],
  projects: readonly FirstMateProject[],
): CoordinatorGroup<T> {
  // Becomes `(thread) => thread.coordinatorThreadId` once threads record their coordinator.
  return resolveCoordinatorGroup(threads, inferFirstMateCoordinatorOf(threads, projects));
}

/**
 * The coordinator a fresh page load opens instead of a new draft, whatever its run status: a
 * restart ends every run, so a coordinator kept open all day is rarely live at launch.
 * Several coordinators open the most recently updated.
 */
export function resolveLaunchCoordinator<T extends Pick<EnvironmentThreadShell, "updatedAt">>(
  group: CoordinatorGroup<T>,
): T | null {
  let launch: T | null = null;
  for (const coordinator of group.coordinators) {
    if (launch === null || coordinator.updatedAt > launch.updatedAt) launch = coordinator;
  }
  return launch;
}
