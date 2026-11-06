import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SidebarSection, SidebarThreadStatus } from "../Sidebar.logic";
import type { CrewTreePlace } from "./SidebarCrewTree";

/**
 * The coordinator a thread names, if any. A coordinator is an unarchived thread pinned as its
 * project's coordinator or named by some thread; its crew are the other unarchived threads naming
 * it. The sidebar lists both above Pinned and keeps them out of Working.
 */
export type CoordinatorOf<T> = (thread: T) => ThreadId | null;

type GroupThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "archivedAt" | "coordinator"
>;

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
    if (thread.coordinator === true && thread.archivedAt === null) coordinators.add(thread);
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

/**
 * Where a thread the sidebar would otherwise list in `section` goes instead, if anywhere. It runs
 * before the Working split, so none ever reaches Working. Snoozing or settling is the way out
 * of the group; pinning changes nothing because the group already sits above Pinned. A decision
 * thread is listed with the group, under the crew (see `resolveCrewTreePlace`).
 */
export function coordinatorGroupSlot<T extends Pick<EnvironmentThreadShell, "decisionOf">>(
  group: CoordinatorGroup<T>,
  thread: T,
  section: SidebarSection,
): "coordinator" | "crew" | "decision" | null {
  if (section === "snoozed" || section === "settled") return null;
  if (group.coordinators.has(thread)) return "coordinator";
  if (group.crew.has(thread)) return "crew";
  return thread.decisionOf === undefined ? null : "decision";
}

/**
 * Where a row sits in the tree under the coordinator card, if it is in the tree. Crewmates and
 * then decisions hang on the guide line and collapse together; with no coordinator card listed,
 * decisions stay at the top level.
 */
export function resolveCrewTreePlace(input: {
  readonly slot: "coordinator" | "crew" | "decision";
  readonly coordinatorListed: boolean;
  readonly crewExpanded: boolean;
  readonly lastInTree: boolean;
}): CrewTreePlace | undefined {
  if (input.slot === "coordinator") return undefined;
  if (input.slot === "decision" && !input.coordinatorListed) return undefined;
  return !input.crewExpanded ? "indent" : input.lastInTree ? "last" : "branch";
}

/** Newest update first, so a decision whose context just changed comes to the top. */
export function sortDecisionThreads<
  T extends Pick<EnvironmentThreadShell, "decisionUpdatedAt" | "createdAt">,
>(threads: readonly T[]): T[] {
  const at = (thread: T) => Date.parse(thread.decisionUpdatedAt ?? thread.createdAt);
  return threads.toSorted((left, right) => at(right) - at(left));
}

type CrewThread = GroupThread & Pick<EnvironmentThreadShell, "crewOf">;

/** The coordinator a thread was launched as crew of. */
export const crewCoordinatorOf: CoordinatorOf<CrewThread> = (thread) => thread.crewOf ?? null;

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
 * The label a crew card shows in its status slot. It stands in for a calm status or the age only:
 * a label is a coordinator's note and can lag, so a thread that needs the user still says so.
 */
export function resolveCrewStatusLabel(input: {
  readonly crew: boolean;
  readonly statusLabel: string | undefined;
  readonly status: SidebarThreadStatus;
  readonly isWoke: boolean;
}): string | null {
  if (!input.crew || input.statusLabel === undefined || input.isWoke) return null;
  const calm = input.status === "working" || input.status === "waiting" || input.status === "ready";
  return calm ? input.statusLabel : null;
}

/**
 * Whether a coordinator card's status slot shows how long ago it started, which says when it is
 * due for a fresh session. Busy and needs-the-user statuses keep the slot, as on crew cards.
 */
export function showsCoordinatorAge(input: {
  readonly coordinator: boolean;
  readonly status: SidebarThreadStatus;
  readonly isWoke: boolean;
}): boolean {
  return input.coordinator && input.status === "ready" && !input.isWoke;
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
