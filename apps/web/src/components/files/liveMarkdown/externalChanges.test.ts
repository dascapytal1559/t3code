import { history, undo, undoDepth } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";

import { externalChangeSpec, lineFlash } from "./externalChanges";
import { lineChanges } from "./lineDiff";

const editorOn = (doc: string) => EditorState.create({ doc, extensions: [history(), lineFlash] });

/** The 1-based numbers of the lines tinted as just changed. */
function flashedLines(state: EditorState): number[] {
  const lines: number[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
      if (cursor.value.spec.class === "cm-lp-flash") {
        lines.push(state.doc.lineAt(cursor.from).number);
      }
    }
  }
  return lines;
}

const fromDisk = (state: EditorState, next: string) =>
  state.update(externalChangeSpec(state, lineChanges(state.doc.toString(), next))).state;

describe("changes from disk", () => {
  it.each([
    ["a line rewritten in the middle", "a\nb\nc", "a\nB\nc", [2]],
    ["two separate lines rewritten", "a\nb\nc\nd\ne", "A\nb\nc\nd\nE", [1, 5]],
    ["lines added before a kept line", "a\nd", "a\nb\nc\nd", [2, 3]],
    ["lines added at the end", "a", "a\nb\nc", [2, 3]],
    ["a line removed", "a\nb\nc", "a\nc", []],
    ["a word removed from a line", "a\nbig dog\nc", "a\ndog\nc", [2]],
  ])("tints only the lines written: %s", (_name, current, next, lines) => {
    const state = fromDisk(editorOn(current), next);
    expect(state.doc.toString()).toBe(next);
    expect(flashedLines(state)).toEqual(lines);
  });

  it("stay out of undo, which still takes back what was typed", () => {
    const typed = editorOn("one\ntwo").update({
      changes: { from: 7, insert: " typed" },
      userEvent: "input.type",
    }).state;
    let state = fromDisk(typed, "ONE\ntwo typed");
    expect(undoDepth(state)).toBe(1);
    undo({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    expect(state.doc.toString()).toBe("ONE\ntwo");
  });

  it("keeps the caret on its own text when lines above it change", () => {
    const state = EditorState.create({
      doc: "first\nsecond\nthird",
      selection: { anchor: 15 },
      extensions: [lineFlash],
    });
    const next = fromDisk(state, "a much longer first line\nsecond\nthird");
    expect(next.doc.sliceString(next.selection.main.head)).toBe("ird");
  });

  it.each([
    ["a line of a longer file", "The quick brown fox\nsecond", "The quick brown fox.\nsecond"],
    ["the only line of a file", "The quick brown fox", "The quick brown fox."],
  ])("keeps the caret in place when its own line changes: %s", (_name, current, next) => {
    const state = EditorState.create({
      doc: current,
      selection: { anchor: "The quick".length },
      extensions: [lineFlash],
    });
    const changed = fromDisk(state, next);
    expect(changed.doc.toString()).toBe(next);
    expect(changed.selection.main.head).toBe("The quick".length);
  });
});
