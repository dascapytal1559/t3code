import type { Rule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupRules, ruleCopyText } from "./rules.logic";

const approved: Rule = {
  id: "R001",
  group: "Life archive",
  text: "Previews use testing data.",
  status: "approved",
};
const pending: Rule = {
  id: "R010",
  group: "FirstMate · How to work",
  text: "Always run the full suite.",
  status: "pending",
  recommendation: {
    choice: "keep-narrower",
    label: "Keep narrower",
    note: "The touched tests are enough.",
    proposedText: "Run the tests your change touches.",
  },
};

describe("rules", () => {
  it("keeps headings in the order they first appear", () => {
    const later = { ...approved, id: "R002" };
    expect(groupRules([approved, pending, later])).toEqual([
      { group: "Life archive", rules: [approved, later] },
      { group: "FirstMate · How to work", rules: [pending] },
    ]);
  });

  it("copies the rule, and for a pending one the recommendation with its note and wording", () => {
    expect(ruleCopyText(approved)).toBe("Rule R001 (Life archive): Previews use testing data.");
    expect(ruleCopyText(pending)).toBe(
      [
        "Rule R010 (FirstMate · How to work): Always run the full suite.",
        "Your recommendation: Keep narrower — The touched tests are enough.",
        "Proposed wording: Run the tests your change touches.",
      ].join("\n"),
    );
  });
});
