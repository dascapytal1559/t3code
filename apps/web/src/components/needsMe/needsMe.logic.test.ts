import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bridgeSetting,
  decisionAgeTimestamp,
  decisionMarkdownScope,
  formatDay,
  groupNeedsMeDecisions,
  needsMeRowDetail,
  objectiveRow,
  parseObjective,
  splitObjectives,
} from "./needsMe.logic";

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
const now = new Date(2026, 10, 7, 12);

const raised = (iso: string) => ({ at: iso, kind: "raised" as const, text: "Raised." });
const update = (iso: string) => ({ at: iso, kind: "update" as const, text: "Updated." });

const listed = (
  id: string,
  overrides: {
    updatedAt?: string;
    wakeAt?: string;
    answered?: boolean;
    since?: string;
    noEntries?: boolean;
  } = {},
) => ({
  id,
  decision: {
    entries:
      overrides.noEntries === true
        ? []
        : [
            raised(at(1, 9)),
            ...(overrides.updatedAt === undefined ? [] : [update(overrides.updatedAt)]),
          ],
    ...(overrides.since === undefined ? {} : { since: overrides.since }),
    ...(overrides.wakeAt === undefined ? {} : { wakeAt: overrides.wakeAt }),
    ...(overrides.answered === true
      ? { answered: { commandId: CommandId.make("reply"), at: at(6, 9) } }
      : {}),
  },
});

describe("groupNeedsMeDecisions", () => {
  it("lists waiting decisions newest update first, those with a return date ahead under Scheduled soonest first, and drops answered ones", () => {
    const groups = groupNeedsMeDecisions(
      [
        listed("raised-only"),
        // With no entries, a decision ranks by when it began waiting.
        listed("no-entries", { noEntries: true, since: at(2, 9) }),
        listed("updated-before", { updatedAt: at(4, 9) }),
        listed("updated-last", { updatedAt: at(5, 9) }),
        listed("back-later", { wakeAt: at(20, 9) }),
        listed("back-soon", { wakeAt: at(19, 9) }),
        // A return date that has passed waits on the user again.
        listed("returned", { wakeAt: at(7, 8), updatedAt: at(3, 9) }),
        listed("answered", { answered: true }),
        listed("answered-then-scheduled", { answered: true, wakeAt: at(21, 9) }),
      ],
      now,
    );
    const ids = (list: ReadonlyArray<{ id: string }>) => list.map((item) => item.id);
    expect(ids(groups.open)).toEqual([
      "updated-last",
      "updated-before",
      "returned",
      "no-entries",
      "raised-only",
    ]);
    expect(ids(groups.scheduled)).toEqual(["back-soon", "back-later"]);
  });
});

describe("needsMeRowDetail", () => {
  it("shows Needs you rows their age and Scheduled rows their return day", () => {
    const decision = {
      entries: [raised(at(1, 9)), update(at(7, 10))],
      since: at(3, 9),
      wakeAt: at(20, 9),
    };
    const nowMs = now.getTime();
    expect(needsMeRowDetail(decision, "open", nowMs)).toBe("2h ago");
    expect(needsMeRowDetail(decision, "scheduled", nowMs)).toBe(`back ${formatDay(at(20, 9))}`);
    expect(needsMeRowDetail({ entries: [] }, "open", nowMs)).toBe("");
  });
});

describe("bridgeSetting", () => {
  it("shows the host environment's objectives, else another environment's, else none", () => {
    const host = EnvironmentId.make("host");
    const other = EnvironmentId.make("other");
    const config = (markdown: string | null) => ({
      settings: { objectives: markdown === null ? null : { markdown } },
    });
    expect(
      bridgeSetting(
        new Map([
          [other, config("- **Other**")],
          [host, config("- **Host**")],
        ]),
        host,
        "objectives",
      ),
    ).toEqual({ markdown: "- **Host**" });
    expect(
      bridgeSetting(
        new Map([
          [host, config(null)],
          [other, config("- **Other**")],
        ]),
        host,
        "objectives",
      ),
    ).toEqual({ markdown: "- **Other**" });
    expect(bridgeSetting(new Map([[host, config(null)]]), host, "objectives")).toBeNull();
    // With no routing table set anywhere, the Bridge leaves its section out.
    expect(
      bridgeSetting(new Map([[host, { settings: { modelRouting: null } }]]), host, "modelRouting"),
    ).toBeNull();
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

describe("objectiveRow", () => {
  it("titles an unnamed objective by its first line and drops a body that only repeats it", () => {
    expect(objectiveRow("**Ship** — the Bridge")).toEqual({ title: "Ship", body: "the Bridge" });
    expect(objectiveRow("**Third**")).toEqual({ title: "Third", body: "" });
    expect(objectiveRow("Focus this week\nmore detail")).toEqual({
      title: "Focus this week",
      body: "Focus this week\nmore detail",
    });
    expect(objectiveRow("Just prose.")).toEqual({ title: "Just prose.", body: "" });
  });
});

describe("decisionMarkdownScope", () => {
  const environment = EnvironmentId.make("local");
  const coordinatorRef = { environmentId: environment, threadId: ThreadId.make("firstmate") };
  const hostRef = { environmentId: environment, threadId: ThreadId.make("host-chat") };

  it("opens a decision's files in the host chat's panel, relative to that chat's workspace", () => {
    expect(
      decisionMarkdownScope({
        coordinatorRef,
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

  it("keeps FirstMate's own scope when the host chat is on another environment", () => {
    const remoteHost = { environmentId: EnvironmentId.make("remote"), threadId: hostRef.threadId };
    expect(
      decisionMarkdownScope({
        coordinatorRef,
        hostRef: remoteHost,
        decisionRoot: "/home/user/firstmate",
        hostRoot: "/srv/app",
      }),
    ).toEqual({
      threadRef: coordinatorRef,
      cwd: "/home/user/firstmate",
      imageBaseDir: "/home/user/firstmate",
    });
  });
});

describe("decisionAgeTimestamp", () => {
  it("counts from the latest real change, else from when the decision began waiting, else its raised entry", () => {
    const entries = [raised(at(1, 9))];
    expect(
      decisionAgeTimestamp({ entries: [...entries, update(at(7, 11))], since: at(2, 9) }),
    ).toBe(at(7, 11));
    expect(decisionAgeTimestamp({ entries, since: at(2, 9) })).toBe(at(2, 9));
    expect(decisionAgeTimestamp({ entries })).toBe(at(1, 9));
    expect(decisionAgeTimestamp({ entries: [] })).toBeNull();
  });

  it("does not let a change from before the decision began waiting reset the age", () => {
    expect(
      decisionAgeTimestamp({ entries: [raised(at(1, 9)), update(at(2, 9))], since: at(3, 9) }),
    ).toBe(at(3, 9));
  });
});
