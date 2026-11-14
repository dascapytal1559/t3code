import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import { listKeymap } from "./formatting";

/** Runs a command on text where `|` marks the caret, or a pair marks a selection. */
function runCommand(command: StateCommand, marked: string): string | false {
  const first = marked.indexOf("|");
  const second = marked.indexOf("|", first + 1);
  const doc = marked.replaceAll("|", "");
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(first, second < 0 ? first : second - 1),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  if (!handled) return false;
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}|${text.slice(from, to)}|${text.slice(to)}`;
}

const key = (name: string) => {
  const binding = listKeymap.find((candidate) => candidate.key === name);
  if (!binding?.run) throw new Error(`no binding for ${name}`);
  // A state command only reads the state and dispatch that a view also has.
  return binding.run as unknown as StateCommand;
};

describe("Tab in lists", () => {
  it.each([
    ["nests a bullet by its marker's width", "Tab", "- a\n- b|", "- a\n  - b|"],
    ["nests a numbered item under its number", "Tab", "1. a\n2. b|", "1. a\n   2. b|"],
    ["moves a nested item back out", "Shift-Tab", "- a\n  - b|", "- a\n- b|"],
    [
      "does nothing in prose, where indentation would start a code block",
      "Tab",
      "pro|se",
      "pro|se",
    ],
    ["indents inside a code block", "Tab", "```\nco|de\n```", "```\n  co|de\n```"],
  ])("%s", (_name, binding, before, after) => {
    expect(runCommand(key(binding), before)).toBe(after);
  });
});
