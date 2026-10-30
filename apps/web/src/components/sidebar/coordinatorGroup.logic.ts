import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SidebarSection } from "../Sidebar.logic";

/**
 * The coordinator a thread names, if any. A coordinator is an unarchived thread some thread names;
 * its crew are the other unarchived threads naming it. The sidebar lists both above Pinned and
 * keeps them out of Working.
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

type CrewThread = GroupThread & Pick<EnvironmentThreadShell, "lineage">;

/** The coordinator a thread's lineage names: the parent it was launched as crew of. */
export const crewCoordinatorOf: CoordinatorOf<CrewThread> = (thread) =>
  thread.lineage.relationshipToParent === "crew" ? thread.lineage.parentThreadId : null;

/** The coordinator group the app shows and opens. */
export function resolveAppCoordinatorGroup<T extends CrewThread>(
  threads: readonly T[],
): CoordinatorGroup<T> {
  return resolveCoordinatorGroup(threads, crewCoordinatorOf);
}

/** Whether the app's coordinator group lists a thread as crew; crew stays out of notifications. */
export function isAppCrewmate<T extends CrewThread>(
  threads: readonly T[],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  for (const member of resolveAppCoordinatorGroup(threads).crew) {
    if (member.environmentId === environmentId && member.id === threadId) return true;
  }
  return false;
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
