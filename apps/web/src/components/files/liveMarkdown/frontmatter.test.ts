import { describe, expect, it } from "vite-plus/test";

import { frontmatterRows } from "./frontmatter";

describe("frontmatterRows", () => {
  it("reads top-level keys, joining list items and block text onto their key", () => {
    const block = [
      "---",
      'title: "Autumn: tide survey"',
      "tags:",
      "  - tides",
      "  - 'harbour'",
      "aliases: [survey, autumn]",
      "# a comment",
      "summary: |",
      "  First line.",
      "  Second line.",
      "empty:",
      "---",
    ].join("\n");
    expect(frontmatterRows(block)).toEqual([
      { key: "title", value: "Autumn: tide survey" },
      { key: "tags", value: "tides, harbour" },
      { key: "aliases", value: "survey, autumn" },
      { key: "summary", value: "First line. Second line." },
      { key: "empty", value: "" },
    ]);
  });

  it("has no rows for a block without keys or without a block at all", () => {
    expect(frontmatterRows("---\n---")).toEqual([]);
    expect(frontmatterRows("")).toEqual([]);
  });
});
