import { describe, expect, it } from "vite-plus/test";

import { splitSkippedRecords } from "./usageSkippedRecords";

const SKIPPED =
  "40 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.";

describe("splitSkippedRecords", () => {
  it.each([
    ["only the skipped sentence", SKIPPED, { notice: null, skipped: SKIPPED }],
    [
      "a source message joined with it",
      `Cursor usage is delayed. ${SKIPPED}`,
      { notice: "Cursor usage is delayed.", skipped: SKIPPED },
    ],
    [
      "a message without it",
      "No transcript directory on this environment.",
      { notice: "No transcript directory on this environment.", skipped: null },
    ],
  ])("splits %s", (_name, message, expected) => {
    expect(splitSkippedRecords(message)).toEqual(expected);
  });
});
