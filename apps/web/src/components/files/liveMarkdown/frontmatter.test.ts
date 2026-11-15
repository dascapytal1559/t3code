import { describe, expect, it } from "vite-plus/test";

import { frontmatterRows } from "./frontmatter";
import { fileFormatOf, fromEditorText, toEditorText } from "./lineEndings";

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

describe("line endings", () => {
  it.each([
    ["a\nb\n", "lf", "a\nb\n"],
    ["a\r\nb\r\n", "crlf", "a\nb\n"],
    // A mixed file keeps every byte, carriage returns included, as ordinary text.
    ["a\r\nb\nc", "mixed", "a\r\nb\nc"],
    ["a\rb", "mixed", "a\rb"],
    // A byte order mark is no text to the Markdown grammar, so a heading under one stays a heading.
    ["\uFEFF# Title\r\n", "crlf", "# Title\n"],
  ] as const)("holds %j as %s and writes the same bytes back", (text, ending, held) => {
    const format = fileFormatOf(text);
    expect(format.ending).toBe(ending);
    expect(toEditorText(text, format)).toBe(held);
    expect(fromEditorText(held, format)).toBe(text);
  });

  it("keeps a file's line ending when its new text has no line break", () => {
    const crlf = fileFormatOf("a\r\nb");
    const oneLine = fileFormatOf("a", crlf);
    expect(oneLine.ending).toBe("crlf");
    expect(fromEditorText("a\nb", oneLine)).toBe("a\r\nb");
    expect(fileFormatOf("a\nb", crlf).ending).toBe("lf");
  });
});
