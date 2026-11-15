import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import { formatKeymap, listKeymap } from "./formatting";

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
  const binding = [...formatKeymap, ...listKeymap].find((candidate) => candidate.key === name);
  if (!binding?.run) throw new Error(`no binding for ${name}`);
  // A state command only reads the state and dispatch that a view also has.
  return binding.run as unknown as StateCommand;
};

describe("formatting shortcuts", () => {
  it.each([
    ["bold wraps a selection", "Mod-b", "a |word| b", "a **|word|** b"],
    ["bold unwraps a selection inside the marks", "Mod-b", "a **|word|** b", "a |word| b"],
    ["bold unwraps a selection that includes the marks", "Mod-b", "a |**word**| b", "a |word| b"],
    ["italic at a bare caret opens a pair to type into", "Mod-i", "a |word", "a *|*word"],
    ["italic on a bold word adds italic", "Mod-i", "a **|word|** b", "a ***|word|*** b"],
    ["italic on a selected bold word adds italic", "Mod-i", "a |**word**| b", "a *|**word**|* b"],
    ["italic comes off a bold italic word", "Mod-i", "a ***|word|*** b", "a **|word|** b"],
    [
      "bold wraps two bold spans rather than joining them",
      "Mod-b",
      "|**a** and **b**|",
      "**|**a** and **b**|**",
    ],
    [
      "italic wraps two italic spans rather than joining them",
      "Mod-i",
      "|*a* and *b*|",
      "*|*a* and *b*|*",
    ],
    ["inline code wraps two code spans", "Mod-e", "|`a` and `b`|", "`|`a` and `b`|`"],
    ["bold leaves out a selected line's break", "Mod-b", "|line\n|next", "**|line|**\nnext"],
    ["inline code wraps a selection", "Mod-e", "run |pnpm test| now", "run `|pnpm test|` now"],
    ["strikethrough wraps a selection", "Mod-Alt-x", "|gone|", "~~|gone|~~"],
    ["a plain line becomes an open task", "Mod-l", "  buy| milk", "  - [ ] buy| milk"],
    ["a bullet gains a box", "Mod-l", "- buy| milk", "- [ ] buy| milk"],
    ["an open task is ticked", "Mod-l", "1. [ ] buy| milk", "1. [x] buy| milk"],
    ["a done task opens again", "Mod-l", "- [x] buy| milk", "- [ ] buy| milk"],
    ["every selected line is toggled", "Mod-l", "- [ ] |a\n- [x] b|", "- [x] |a\n- [ ] b|"],
    [
      "a selection ending at a line's start leaves that line alone",
      "Mod-l",
      "- [ ] |a\n|- [ ] b",
      "- [x] |a\n|- [ ] b",
    ],
  ])("%s", (_name, binding, before, after) => {
    expect(runCommand(key(binding), before)).toBe(after);
  });

  it("leaves Mod-b alone at a bare caret, where it is the app's sidebar toggle", () => {
    expect(runCommand(key("Mod-b"), "a |word")).toBe(false);
  });
});

describe("Tab in lists", () => {
  it.each([
    ["nests a bullet by its marker's width", "Tab", "- a\n- b|", "- a\n  - b|"],
    ["nests a numbered item under its number", "Tab", "1. a\n2. b|", "1. a\n   2. b|"],
    ["moves a nested item back out", "Shift-Tab", "- a\n  - b|", "- a\n- b|"],
    [
      "nests a bullet under a numbered item's text",
      "Tab",
      "1. Step\n- detail|",
      "1. Step\n   - detail|",
    ],
    ["moves a nested item back to its parent's indent", "Shift-Tab", "1. a\n   - b|", "1. a\n- b|"],
    [
      "moves only the lines a selection covers",
      "Shift-Tab",
      "- a\n  - |b\n|  - c",
      "- a\n- |b\n|  - c",
    ],
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
