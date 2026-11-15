import { describe, expect, it } from "vite-plus/test";

import { fromEditorText, lineEndingOf, toEditorText } from "./lineEndings";

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
