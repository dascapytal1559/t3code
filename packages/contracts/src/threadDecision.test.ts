import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadDecision, ThreadDecisionInput } from "./threadDecision.ts";

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
});
