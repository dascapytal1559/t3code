import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DecisionsSetInput,
  decisionChangedAt,
  decisionSince,
  decisionUpdatedAt,
  formatDecisionReply,
} from "./decisions.ts";

const decodeSet = Schema.decodeUnknownSync(DecisionsSetInput);

const decision = {
  id: "camera-view-first-camera",
  title: "First window camera",
  question: "Give the word to buy the first window-view camera?",
  options: [{ label: "Buy it" }],
  entries: [{ at: "2026-11-05T05:11:27.000Z", kind: "raised", text: "Ready to buy." }],
  revision: 1,
};

describe("decisions", () => {
  it("takes a list, and refuses two decisions with one id or a date it cannot read", () => {
    const replyTo = "thread:firstmate";
    const other = { ...decision, id: "garden-shed-paint", wakeAt: "2026-11-12T00:00:00Z" };
    expect(decodeSet({ replyTo, decisions: [decision, other] }).decisions).toHaveLength(2);
    expect(() => decodeSet({ replyTo, decisions: [decision, decision] })).toThrow();
    expect(() =>
      decodeSet({ replyTo, decisions: [{ ...decision, wakeAt: "next week" }] }),
    ).toThrow();
  });

  it("counts the wait from `since`, else from the earliest entry", () => {
    const entries = [
      { at: "2026-11-05T09:00:00.000Z", kind: "update", text: "More context." },
      { at: "2026-11-05T05:11:27.000Z", kind: "raised", text: "Ready to buy." },
    ] as const;
    expect(decisionSince({ entries })).toBe("2026-11-05T05:11:27.000Z");
    expect(decisionSince({ entries, since: "2026-09-22T00:00:00.000Z" })).toBe(
      "2026-09-22T00:00:00.000Z",
    );
    expect(decisionSince({ entries: [] })).toBeNull();
  });

  it("dates the latest change from `update` entries only, not a reworded raise", () => {
    const entries = [
      { at: "2026-11-07T09:00:00.000Z", kind: "raised", text: "Reworded." },
      { at: "2026-11-05T09:00:00.000Z", kind: "update", text: "More context." },
      { at: "2026-11-03T09:00:00.000Z", kind: "update", text: "Earlier." },
    ] as const;
    expect(decisionUpdatedAt({ entries })).toBe("2026-11-07T09:00:00.000Z");
    expect(decisionChangedAt({ entries })).toBe("2026-11-05T09:00:00.000Z");
    expect(decisionChangedAt({ entries: [entries[0]] })).toBeNull();
  });

  it("puts the decision's id on its own line of the reply, for FirstMate to parse", () => {
    expect(
      formatDecisionReply({
        decision: { ...decision, question: "Buy the camera?\n\nIt costs 200." },
        text: "  Buy it.  ",
      }),
    ).toBe(
      [
        "**Decision · First window camera**",
        "needs-me-task: camera-view-first-camera",
        "",
        "> Buy the camera?",
        ">",
        "> It costs 200.",
        "",
        "Buy it.",
      ].join("\n"),
    );
  });
});
