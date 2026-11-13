import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentNameByProjectTitle,
  bridgeReports,
  bridgeSetting,
  decisionAgeTimestamp,
  decisionMarkdownScope,
  formatDay,
  groupNeedsMeDecisions,
  needsMeRowDetail,
  nightHeading,
  objectiveRow,
  parseObjective,
  reportNight,
  reportsByNight,
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
    snoozedUntil?: string | null;
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
    ...(overrides.snoozedUntil === undefined
      ? {}
      : { snoozed: { at: at(6, 9), until: overrides.snoozedUntil } }),
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
        listed("back-later", { snoozedUntil: at(20, 9) }),
        listed("back-soon", { snoozedUntil: at(19, 9) }),
        // Snoozed with no date: it waits until brought back, after every dated one.
        listed("no-date", { snoozedUntil: null }),
        // A return date that has passed waits on the user again.
        listed("returned", { snoozedUntil: at(7, 8), updatedAt: at(3, 9) }),
        listed("answered", { answered: true }),
        listed("answered-then-scheduled", { answered: true, snoozedUntil: at(21, 9) }),
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
    expect(ids(groups.scheduled)).toEqual(["back-soon", "back-later", "no-date"]);
  });
});

describe("needsMeRowDetail", () => {
  it("shows Needs you rows their age and Scheduled rows their return day", () => {
    const decision = {
      entries: [raised(at(1, 9)), update(at(7, 10))],
      since: at(3, 9),
      snoozed: { at: at(6, 9), until: at(20, 9) },
    };
    const nowMs = now.getTime();
    expect(needsMeRowDetail(decision, "open", nowMs)).toBe("2h ago");
    expect(needsMeRowDetail(decision, "scheduled", nowMs)).toBe(`back ${formatDay(at(20, 9))}`);
    expect(needsMeRowDetail({ entries: [] }, "open", nowMs)).toBe("");
    expect(
      needsMeRowDetail({ entries: [], snoozed: { at: at(6, 9), until: null } }, "scheduled", nowMs),
    ).toBe("snoozed");
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

  it("shows the reports of the first environment with any, newest pin first", () => {
    const host = EnvironmentId.make("host");
    const other = EnvironmentId.make("other");
    const report = (title: string, pinnedAt: string) => ({
      title,
      summary: "Found it.",
      location: "/reports/a.md",
      pinnedAt,
    });
    const configs = new Map([
      [
        other,
        {
          settings: {
            pinnedReports: { old: report("Old", at(1, 9)), new: report("New", at(2, 9)) },
          },
        },
      ],
      [host, { settings: { pinnedReports: {} } }],
    ]);
    // A host with none falls through: an empty record is not a set value.
    expect(bridgeReports(configs, host)).toEqual({
      environmentId: other,
      reports: [
        { id: "new", ...report("New", at(2, 9)) },
        { id: "old", ...report("Old", at(1, 9)) },
      ],
    });
    expect(bridgeReports(new Map([[host, { settings: { pinnedReports: {} } }]]), host)).toBeNull();
  });
});

describe("reports by night", () => {
  const sydney = "Australia/Sydney";
  const losAngeles = "America/Los_Angeles";

  it("counts a pin before local noon as the night before, unless FirstMate names the night", () => {
    // 07:30 and 12:00 on 13 Nov in Sydney (UTC+11).
    expect(reportNight({ pinnedAt: "2026-11-12T20:30:00.000Z" }, sydney)).toBe("2026-11-12");
    expect(reportNight({ pinnedAt: "2026-11-13T01:00:00.000Z" }, sydney)).toBe("2026-11-13");
    // One instant, two zones: 13:00 on 13 Nov in Sydney, 18:00 on 12 Nov in Los Angeles.
    expect(reportNight({ pinnedAt: "2026-11-13T02:00:00.000Z" }, sydney)).toBe("2026-11-13");
    expect(reportNight({ pinnedAt: "2026-11-13T02:00:00.000Z" }, losAngeles)).toBe("2026-11-12");
    expect(reportNight({ pinnedAt: "2026-11-13T02:00:00.000Z", night: "2026-11-09" }, sydney)).toBe(
      "2026-11-09",
    );
  });

  it("groups reports by night, latest night first, keeping newest first within one", () => {
    const report = (id: string, pinnedAt: string, night?: string) => ({
      id,
      pinnedAt,
      ...(night === undefined ? {} : { night }),
    });
    // Sydney times: 14:00 on 13 Nov, 09:00, 06:00 and 23:00 on 12 Nov, 21:00 on 11 Nov.
    const newestFirst = [
      report("afternoon", "2026-11-13T03:00:00.000Z"),
      report("catch-up", "2026-11-12T22:00:00.000Z", "2026-11-11"),
      report("dawn", "2026-11-12T19:00:00.000Z"),
      report("late", "2026-11-12T12:00:00.000Z"),
      report("older", "2026-11-11T10:00:00.000Z"),
    ];
    expect(
      reportsByNight(newestFirst, sydney).map(({ night, reports }) => [
        night,
        reports.map(({ id }) => id),
      ]),
    ).toEqual([
      ["2026-11-13", ["afternoon"]],
      ["2026-11-12", ["dawn", "late"]],
      ["2026-11-11", ["catch-up", "older"]],
    ]);
  });

  it("names last night and tonight in the viewer's zone, and older nights by weekday", () => {
    const now = new Date("2026-11-13T02:00:00.000Z");
    expect(nightHeading("2026-11-12", now, sydney)).toMatch(/^Last night · /);
    expect(nightHeading("2026-11-12", now, losAngeles)).toMatch(/^Tonight · /);
    expect(nightHeading("2026-11-10", now, sydney)).not.toMatch(/night/i);
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

describe("agentNameByProjectTitle", () => {
  const local = EnvironmentId.make("environment-local");
  const remote = EnvironmentId.make("environment-remote");

  it("names the agent of the one project with that title in the environment", () => {
    const agentNameFor = agentNameByProjectTitle([
      { environmentId: local, title: "rituals", agentName: "Life log" },
      { environmentId: local, title: "api", agentName: null },
      { environmentId: remote, title: "rituals" },
    ]);
    expect(agentNameFor(local, "rituals")).toBe("Life log");
    expect(agentNameFor(remote, "rituals")).toBeNull();
    expect(agentNameFor(local, "api")).toBeNull();
    expect(agentNameFor(local, "missing")).toBeNull();
  });

  it("names no agent when two projects in the environment share the title", () => {
    for (const projects of [
      [
        { environmentId: local, title: "api" },
        { environmentId: local, title: "api", agentName: "Life log" },
      ],
      [
        { environmentId: local, title: "api", agentName: "Life log" },
        { environmentId: local, title: "api" },
      ],
    ]) {
      expect(agentNameByProjectTitle(projects)(local, "api")).toBeNull();
    }
  });
});
