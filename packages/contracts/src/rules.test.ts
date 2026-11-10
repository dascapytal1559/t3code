import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RulesSetInput } from "./rules.ts";

const decodeSet = Schema.decodeUnknownSync(RulesSetInput);

const approved = {
  id: "R001",
  group: "Life archive",
  text: "Previews use testing data.",
  status: "approved",
  approvedOn: "2026-11-07",
};
const pending = {
  id: "R010",
  group: "FirstMate · How to work",
  text: "Always run the full suite.",
  status: "pending",
  recommendation: { choice: "keep-narrower", label: "Keep narrower" },
};

describe("rules", () => {
  it("takes approved and pending rules, and an empty list", () => {
    expect(decodeSet({ rules: [approved, pending] }).rules).toHaveLength(2);
    expect(decodeSet({ rules: [] }).rules).toHaveLength(0);
  });

  it.each([
    ["a pending rule with no recommendation", [{ ...pending, recommendation: undefined }]],
    ["an unknown choice", [{ ...pending, recommendation: { choice: "maybe", label: "Maybe" } }]],
    ["two rules with one id", [pending, pending]],
    ["an approvedOn that is not a day", [{ ...approved, approvedOn: "7 Nov" }]],
    ["text over 2,000 characters", [{ ...approved, text: "x".repeat(2_001) }]],
    [
      "a note over 2,000 characters",
      [{ ...pending, recommendation: { ...pending.recommendation, note: "x".repeat(2_001) } }],
    ],
    [
      "proposed text over 2,000 characters",
      [
        {
          ...pending,
          recommendation: { ...pending.recommendation, proposedText: "x".repeat(2_001) },
        },
      ],
    ],
    ["more than 400 rules", Array.from({ length: 401 }, (_, i) => ({ ...approved, id: `R${i}` }))],
  ])("refuses %s rather than cutting it", (_, rules) => {
    expect(() => decodeSet({ rules })).toThrow();
  });
});
