import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bridgeObjectives,
  decisionAgeTimestamp,
  decisionMarkdownScope,
  formatDay,
  groupNeedsMeDecisions,
  isNeedsMeListed,
  needsMeRowDetail,
  parseObjective,
  splitObjectives,
} from "./needsMe.logic";

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
  it("lists open decisions newest update first, undated snoozes under Later, dated ones under Scheduled soonest first, and drops settled ones", () => {
    const groups = groupNeedsMeDecisions(
      [
        decision("ordinary-thread", { decisionOf: null }),
        decision("archived", { archivedAt: at(6, 9) }),
        // With no entries, a decision ranks by when it was made.
        decision("no-entries"),
        decision("updated-before", { decisionUpdatedAt: at(4, 9) }),
        decision("updated-last", { decisionUpdatedAt: at(5, 9) }),
        decision("undated-snooze", { snoozedAt: at(6, 10) }),
        decision("undated-snooze-earlier", { snoozedAt: at(5, 10) }),
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
    expect(ids(groups.later)).toEqual(["undated-snooze", "undated-snooze-earlier"]);
    expect(ids(groups.scheduled)).toEqual(["back-soon", "back-later"]);
  });
});

describe("isNeedsMeListed", () => {
  it("is false for a decision the tab has no row for, so its address does not open the tab", () => {
    expect(isNeedsMeListed(decision("open"))).toBe(true);
    expect(isNeedsMeListed(decision("snoozed", { snoozedUntil: at(20, 9) }))).toBe(true);
    expect(isNeedsMeListed(decision("answered", { settled: true }))).toBe(false);
    expect(
      isNeedsMeListed(
        decision("answered-then-snoozed", { settled: true, snoozedUntil: at(20, 9) }),
      ),
    ).toBe(false);
    expect(isNeedsMeListed(decision("archived", { archivedAt: at(6, 9) }))).toBe(false);
    expect(isNeedsMeListed(decision("ordinary-thread", { decisionOf: null }))).toBe(false);
  });
});

describe("needsMeRowDetail", () => {
  it("shows Needs you rows their age, Later rows the day they were raised, Scheduled rows their wake day", () => {
    const row = {
      createdAt: at(1, 9),
      decisionSince: at(3, 9),
      decisionChangedAt: at(7, 10),
      snoozedUntil: at(20, 9),
    };
    const nowMs = now.getTime();
    expect(needsMeRowDetail(row, "open", nowMs)).toBe("2h ago");
    // Inception, not the last update and not a snooze date.
    expect(needsMeRowDetail(row, "later", nowMs)).toBe(`raised ${formatDay(at(3, 9))}`);
    const { decisionSince: _since, ...withoutSince } = row;
    expect(needsMeRowDetail(withoutSince, "later", nowMs)).toBe(`raised ${formatDay(at(1, 9))}`);
    expect(needsMeRowDetail(row, "scheduled", nowMs)).toBe(`back ${formatDay(at(20, 9))}`);
  });
});

describe("bridgeObjectives", () => {
  it("shows the host environment's objectives, else another environment's, else none", () => {
    const host = EnvironmentId.make("host");
    const other = EnvironmentId.make("other");
    const config = (markdown: string | null) => ({
      settings: { objectives: markdown === null ? null : { markdown } },
    });
    expect(
      bridgeObjectives(
        new Map([
          [other, config("- **Other**")],
          [host, config("- **Host**")],
        ]),
        host,
      ),
    ).toEqual({ markdown: "- **Host**" });
    expect(
      bridgeObjectives(
        new Map([
          [host, config(null)],
          [other, config("- **Other**")],
        ]),
        host,
      ),
    ).toEqual({ markdown: "- **Other**" });
    expect(bridgeObjectives(new Map([[host, config(null)]]), host)).toBeNull();
  });
});

describe("splitObjectives", () => {
  it("makes one entry per top-level bullet, keeping nested lines, else the whole text", () => {
    expect(
      splitObjectives(
        "- **Archive** — get it done\n  more detail\n    - nested\n\n* **Fleet** — keep it small\n1. **Third**",
      ),
    ).toEqual([
      "**Archive** — get it done\n  more detail\n    - nested",
      "**Fleet** — keep it small",
      "**Third**",
    ]);
    expect(splitObjectives("- **Ship** — x\n  - detail\n - **Next**")).toEqual([
      "**Ship** — x\n  - detail",
      "**Next**",
    ]);
    expect(splitObjectives("Focus this week\n- **One**")).toEqual(["Focus this week", "**One**"]);
    expect(splitObjectives("  Just prose.  ")).toEqual(["Just prose."]);
    expect(splitObjectives("")).toEqual([]);
  });
});

describe("parseObjective", () => {
  it("takes the bold lead as the name and the rest, past a dash or colon, as the text", () => {
    expect(
      parseObjective(
        "**Modular life archive** — get the life archive to where its parts can be shared individually.",
      ),
    ).toEqual({
      name: "Modular life archive",
      text: "get the life archive to where its parts can be shared individually.",
    });
    expect(
      parseObjective("**Creating content**: “creating content should be an objective”"),
    ).toEqual({ name: "Creating content", text: "“creating content should be an objective”" });
    expect(parseObjective("**Fleet:** keep it small\n  more detail")).toEqual({
      name: "Fleet",
      text: "keep it small\n  more detail",
    });
    expect(parseObjective("**Third**")).toEqual({ name: "Third", text: "" });
    expect(parseObjective("Just prose.")).toEqual({ text: "Just prose." });
    expect(parseObjective("** ** nothing")).toEqual({ text: "** ** nothing" });
  });
});

describe("decisionMarkdownScope", () => {
  const environment = EnvironmentId.make("local");
  const decisionRef = { environmentId: environment, threadId: ThreadId.make("decision") };
  const hostRef = { environmentId: environment, threadId: ThreadId.make("host-chat") };

  it("opens a decision's files in the host chat's panel, relative to that chat's workspace", () => {
    expect(
      decisionMarkdownScope({
        decisionRef,
        hostRef,
        decisionRoot: "/home/user/firstmate",
        hostRoot: "/home/user/acme/app",
      }),
    ).toEqual({
      threadRef: hostRef,
      cwd: "/home/user/acme/app",
      // Relative links in FirstMate's words still mean FirstMate's project.
      imageBaseDir: "/home/user/firstmate",
    });
  });

  it("keeps the decision's own scope when the host chat is on another environment", () => {
    const remoteHost = { environmentId: EnvironmentId.make("remote"), threadId: hostRef.threadId };
    expect(
      decisionMarkdownScope({
        decisionRef,
        hostRef: remoteHost,
        decisionRoot: "/home/user/firstmate",
        hostRoot: "/srv/app",
      }),
    ).toEqual({
      threadRef: decisionRef,
      cwd: "/home/user/firstmate",
      imageBaseDir: "/home/user/firstmate",
    });
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
