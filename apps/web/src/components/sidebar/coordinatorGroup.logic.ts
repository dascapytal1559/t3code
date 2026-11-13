import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  decisionSince,
  type DecisionsState,
  type EnvironmentId,
  type StoredDecision,
  type ThreadId,
} from "@t3tools/contracts";
import { effectiveDecisions, isSnoozedAt } from "../needsMe/needsMe.logic";
import type { SidebarSection, SidebarThreadStatus } from "../Sidebar.logic";

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

type CrewThread = GroupThread & Pick<EnvironmentThreadShell, "crewOf">;

/** The coordinator a thread was launched as crew of. */
export const crewCoordinatorOf: CoordinatorOf<CrewThread> = (thread) => thread.crewOf ?? null;

/** The coordinator group the app shows and opens. */
export function resolveAppCoordinatorGroup<T extends CrewThread>(
  threads: readonly T[],
): CoordinatorGroup<T> {
  return resolveCoordinatorGroup(threads, crewCoordinatorOf);
}

/** Whether a thread is crew, judged from it and the coordinator it names, as the sidebar does. */
export function isCrewOf<T extends CrewThread>(thread: T, coordinator: T | null): boolean {
  return coordinator !== null && resolveAppCoordinatorGroup([thread, coordinator]).crew.has(thread);
}

/** FirstMate's label for a thread it keeps open for the user, who replies to FirstMate or archives it. */
export const CAPTAIN_WAIT_LABEL = "Waiting for captain";

/** What FirstMate's item on a thread asks of the user, shown where a status label sits. */
export type CaptainItemLabel = "Needs you" | "To read" | "Replied";

export interface CaptainCard {
  readonly environmentId: EnvironmentId;
  /** The item the card's reply, Snooze and Archive act on. */
  readonly item: StoredDecision;
  readonly label: CaptainItemLabel;
  /** Set while the item is put off; the card then waits in Snoozed, with no label. */
  readonly snoozed: NonNullable<StoredDecision["snoozed"]> | null;
}

const cardRank = (item: StoredDecision, nowMs: number) =>
  (isSnoozedAt(item.snoozed, nowMs) ? 2 : 0) + (item.kind === "read" ? 1 : 0);

/**
 * The card each thread shows for FirstMate's items, keyed by thread. A thread carrying several
 * shows one: a waiting item over a snoozed one, Needs you over To read, then the oldest.
 */
export function resolveCaptainCards(
  lists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly state: Pick<DecisionsState, "decisions" | "actions">;
  }>,
  nowMs: number,
): ReadonlyMap<string, CaptainCard> {
  const cards = new Map<string, CaptainCard>();
  for (const { environmentId, state } of lists) {
    for (const item of effectiveDecisions(state)) {
      if (item.thread === undefined) continue;
      const key = scopedThreadKey(scopeThreadRef(environmentId, item.thread.id));
      const shown = cards.get(key)?.item;
      if (shown !== undefined) {
        const rank = cardRank(item, nowMs) - cardRank(shown, nowMs);
        const older =
          Date.parse(decisionSince(item) ?? "") < Date.parse(decisionSince(shown) ?? "");
        if (rank > 0 || (rank === 0 && !older)) continue;
      }
      const snoozed = isSnoozedAt(item.snoozed, nowMs) ? item.snoozed : null;
      const label =
        item.answered !== undefined ? "Replied" : item.kind === "read" ? "To read" : "Needs you";
      cards.set(key, { environmentId, item, label, snoozed });
    }
  }
  return cards;
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
