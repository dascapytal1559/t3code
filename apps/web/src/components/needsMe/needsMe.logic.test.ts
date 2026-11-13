import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { bridgeSetting, objectiveRow, parseObjective, splitObjectives } from "./needsMe.logic";

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
