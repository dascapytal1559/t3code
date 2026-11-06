import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decisionAgeTimestamp, groupNeedsMeDecisions, isNeedsMeListed } from "./needsMe.logic";

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
const now = new Date(2026, 10, 7, 12);

const decision = (
  id: string,
  overrides: {
    decisionOf?: string | null;
    decisionUpdatedAt?: string;
    archivedAt?: string;
    settled?: boolean;
    snoozedUntil?: string;
    snoozedAt?: string;
  } = {},
) => ({
  id,
  ...(overrides.decisionOf === null
    ? {}
    : { decisionOf: ThreadId.make(overrides.decisionOf ?? "firstmate") }),
  ...(overrides.decisionUpdatedAt === undefined
    ? {}
    : { decisionUpdatedAt: overrides.decisionUpdatedAt }),
  createdAt: at(1, 9),
  archivedAt: overrides.archivedAt ?? null,
  settledOverride: overrides.settled === true ? ("settled" as const) : null,
  snoozedUntil: overrides.snoozedUntil ?? null,
  snoozedAt: overrides.snoozedAt ?? (overrides.snoozedUntil === undefined ? null : at(6, 9)),
  hasPendingApprovals: false,
  hasPendingUserInput: false,
});

describe("groupNeedsMeDecisions", () => {
  it("lists open decisions newest update first and Later by wake date, and drops settled ones", () => {
    const groups = groupNeedsMeDecisions(
      [
        decision("ordinary-thread", { decisionOf: null }),
        decision("archived", { archivedAt: at(6, 9) }),
        // With no entries, a decision ranks by when it was made.
        decision("no-entries"),
        decision("updated-before", { decisionUpdatedAt: at(4, 9) }),
        decision("updated-last", { decisionUpdatedAt: at(5, 9) }),
        decision("undated-snooze", { snoozedAt: at(6, 10) }),
        decision("back-later", { snoozedUntil: at(20, 9) }),
        decision("back-soon", { snoozedUntil: at(19, 9) }),
        // A snooze whose wake time passed is open again.
        decision("woke", { snoozedUntil: at(7, 8), decisionUpdatedAt: at(3, 9) }),
        decision("answered", { settled: true }),
        decision("answered-then-snoozed", { settled: true, snoozedUntil: at(21, 9) }),
      ],
      now,
    );
    const ids = (list: ReadonlyArray<{ id: string }>) => list.map((thread) => thread.id);
    expect(ids(groups.open)).toEqual(["updated-last", "updated-before", "woke", "no-entries"]);
    expect(ids(groups.later)).toEqual([
      "back-soon",
      "back-later",
      "answered-then-snoozed",
      "undated-snooze",
    ]);
  });
});

describe("isNeedsMeListed", () => {
  it("is false for a decision the tab has no row for, so its address does not open the tab", () => {
    expect(isNeedsMeListed(decision("open"), now)).toBe(true);
    expect(isNeedsMeListed(decision("answered", { settled: true }), now)).toBe(false);
    expect(isNeedsMeListed(decision("archived", { archivedAt: at(6, 9) }), now)).toBe(false);
    expect(isNeedsMeListed(decision("ordinary-thread", { decisionOf: null }), now)).toBe(false);
  });
});

describe("decisionAgeTimestamp", () => {
  it("counts from the latest real change, else from when the call began waiting, else creation", () => {
    const createdAt = at(1, 9);
    expect(
      decisionAgeTimestamp({ decisionChangedAt: at(7, 11), decisionSince: at(2, 9), createdAt }),
    ).toBe(at(7, 11));
    expect(decisionAgeTimestamp({ decisionSince: at(2, 9), createdAt })).toBe(at(2, 9));
    expect(decisionAgeTimestamp({ createdAt })).toBe(createdAt);
  });

  it("does not let a change from before the call began waiting reset the age", () => {
    expect(
      decisionAgeTimestamp({
        decisionChangedAt: at(2, 9),
        decisionSince: at(3, 9),
        createdAt: at(1, 9),
      }),
    ).toBe(at(3, 9));
  });
});
