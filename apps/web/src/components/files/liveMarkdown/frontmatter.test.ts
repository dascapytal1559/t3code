import { describe, expect, it } from "vite-plus/test";

import { frontmatterRows } from "./frontmatter";
import { fromEditorText, lineEndingOf, toEditorText } from "./lineEndings";

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
    ["a\nb\n", "lf"],
    ["a\r\nb\r\n", "crlf"],
  ] as const)("holds %j as plain breaks and writes the same bytes back as %s", (text, ending) => {
    expect(lineEndingOf(text)).toBe(ending);
    expect(toEditorText(text)).toBe("a\nb\n");
    expect(fromEditorText(toEditorText(text), ending)).toBe(text);
  });

  it.each([
    ["mostly CRLF", "a\r\nb\r\nc\nd", "crlf", "a\r\nb\r\nc\r\nd"],
    ["mostly LF", "a\nb\nc\r\nd", "lf", "a\nb\nc\nd"],
    ["a lone carriage return", "a\rb\nc", "lf", "a\nb\nc"],
  ] as const)(
    "writes a file that mixes line endings with the one it uses most: %s",
    (_name, text, ending, saved) => {
      expect(lineEndingOf(text)).toBe(ending);
      expect(fromEditorText(toEditorText(text), lineEndingOf(text))).toBe(saved);
    },
  );

  it("keeps a file's line ending when its new text has no line break", () => {
    expect(lineEndingOf("a", "crlf")).toBe("crlf");
    expect(lineEndingOf("a\nb", "crlf")).toBe("lf");
  });
});
