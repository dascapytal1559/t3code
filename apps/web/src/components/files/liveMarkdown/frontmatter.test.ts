import { describe, expect, it } from "vite-plus/test";

import { EditorState, type StateCommand } from "@codemirror/state";

import { formatKeymap } from "./formatting";
import { frontmatterRows } from "./frontmatter";

import { fromEditorText, lineEndingOf, mixedLineEndings, toEditorText } from "./lineEndings";

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
  ] as const)("holds %j as %s and writes the same bytes back", (text, ending, held) => {
    expect(lineEndingOf(text)).toBe(ending);
    expect(toEditorText(text, ending)).toBe(held);
    expect(fromEditorText(held, ending)).toBe(text);
  });

  it("types at the end of a mixed file's CRLF line before its carriage return", () => {
    const start = EditorState.create({ doc: "# Title\r\nnext\n", extensions: mixedLineEndings });
    const atEnd = start.update({ selection: { anchor: start.doc.line(1).to } }).state;
    const typed = atEnd.update(atEnd.replaceSelection("!"), { userEvent: "input.type" }).state;
    expect(fromEditorText(typed.doc.toString(), "mixed")).toBe("# Title!\r\nnext\n");
    expect(typed.selection.main.head).toBe("# Title!".length);
  });

  it("formats at the end of a mixed file's CRLF line as on an LF line", () => {
    const italic = formatKeymap.find((binding) => binding.key === "Mod-i")?.run;
    if (!italic) throw new Error("no italic binding");
    // A state command only reads the state and dispatch that a view also has.
    const toggle = (state: EditorState) => {
      let next = state;
      (italic as unknown as StateCommand)({ state, dispatch: (tr) => void (next = tr.state) });
      return next;
    };
    const type = (state: EditorState, text: string) =>
      state.update(state.replaceSelection(text), { userEvent: "input.type" }).state;

    const caret = EditorState.create({ doc: "foo\r\nbar\n", extensions: mixedLineEndings });
    const atEnd = caret.update({ selection: { anchor: caret.doc.line(1).to } }).state;
    expect(type(toggle(atEnd), "word").doc.toString()).toBe("foo*word*\r\nbar\n");

    const word = EditorState.create({ doc: "word\r\nbar\n", extensions: mixedLineEndings });
    const selected = word.update({ selection: { anchor: 0, head: word.doc.line(1).to } }).state;
    const wrapped = toggle(selected);
    expect(wrapped.doc.toString()).toBe("*word*\r\nbar\n");
    expect(toggle(wrapped).doc.toString()).toBe("word\r\nbar\n");
  });

  it("lets the caret cross a mixed file's CRLF line end", () => {
    const start = EditorState.create({ doc: "# Title\r\nnext\n", extensions: mixedLineEndings });
    const line = start.doc.line(1);
    const right = start.update({ selection: { anchor: line.to }, userEvent: "select" }).state;
    expect(right.selection.main.head).toBe(line.to);
    const crLast = EditorState.create({ doc: "a\nb\r", extensions: mixedLineEndings });
    const all = crLast.update({ selection: { anchor: 0, head: crLast.doc.length } }).state;
    const cleared = all.update(all.replaceSelection(""), { userEvent: "delete" }).state;
    expect(cleared.doc.toString()).toBe("");
  });

  it("keeps a file's line ending when its new text has no line break", () => {
    expect(lineEndingOf("a", "crlf")).toBe("crlf");
    expect(lineEndingOf("a\nb", "crlf")).toBe("lf");
  });
});
