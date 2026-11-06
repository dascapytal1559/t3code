import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ThreadDecision,
  ThreadDecisionInput,
  threadDecisionChangedAt,
  threadDecisionSince,
  threadDecisionUpdatedAt,
} from "./threadDecision.ts";

const decodeInput = Schema.decodeUnknownSync(ThreadDecisionInput);
const decodeStored = Schema.decodeUnknownSync(ThreadDecision);

const decision = {
  taskId: "camera-view-first-camera",
  title: "First window camera",
  question: "Give the word to buy the first window-view camera?",
  options: [{ label: "Buy it" }],
  entries: [{ at: "2026-11-05T05:11:27.000Z", kind: "raised", text: "Ready to buy." }],
};

describe("ThreadDecision", () => {
  it("carries the project a decision is about", () => {
    expect(decodeInput({ ...decision, projectName: " home-server " }).projectName).toBe(
      "home-server",
    );
  });

  it("still reads a decision stored before it named a project", () => {
    expect(decodeStored({ ...decision, revision: 1 }).projectName).toBeUndefined();
  });

  it("refuses a blank project name", () => {
    expect(() => decodeInput({ ...decision, projectName: "  " })).toThrow();
  });

  it("carries when the call started waiting, and still reads one without", () => {
    expect(decodeInput({ ...decision, since: "2026-09-22T00:00:00.000Z" }).since).toBe(
      "2026-09-22T00:00:00.000Z",
    );
    expect(decodeStored({ ...decision, revision: 1 }).since).toBeUndefined();
    expect(() => decodeInput({ ...decision, since: "last week" })).toThrow();
  });

  it("counts the wait from `since`, else from the earliest entry", () => {
    const entries = [
      { at: "2026-11-05T09:00:00.000Z", kind: "update", text: "More context." },
      { at: "2026-11-05T05:11:27.000Z", kind: "raised", text: "Ready to buy." },
    ] as const;
    expect(threadDecisionSince({ entries })).toBe("2026-11-05T05:11:27.000Z");
    expect(threadDecisionSince({ entries, since: "2026-09-22T00:00:00.000Z" })).toBe(
      "2026-09-22T00:00:00.000Z",
    );
    expect(threadDecisionSince({ entries: [] })).toBeNull();
  });

  it("dates the latest change from `update` entries only, not a reworded raise", () => {
    const entries = [
      { at: "2026-11-07T09:00:00.000Z", kind: "raised", text: "Reworded." },
      { at: "2026-11-05T09:00:00.000Z", kind: "update", text: "More context." },
      { at: "2026-11-03T09:00:00.000Z", kind: "update", text: "Earlier." },
    ] as const;
    expect(threadDecisionUpdatedAt({ entries })).toBe("2026-11-07T09:00:00.000Z");
    expect(threadDecisionChangedAt({ entries })).toBe("2026-11-05T09:00:00.000Z");
    expect(threadDecisionChangedAt({ entries: [entries[0]] })).toBeNull();
  });
});
