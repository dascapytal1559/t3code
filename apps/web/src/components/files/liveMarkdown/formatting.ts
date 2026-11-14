import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type StateCommand,
} from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";

import type { SyntaxNode } from "./markdownSyntax";

/** Indent, list marker with its space, and a task box if the item has one. */
const LIST_LINE = /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[[ xX]\](?=\s|$))?/;

function selectedLineNumbers(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number += 1) {
      numbers.add(number);
    }
  }
  return [...numbers];
}

/** Wraps each selection in `mark`, or unwraps one already wrapped in it. */
function toggleInlineMark(
  mark: string,
  options?: { readonly needsSelection: boolean },
): StateCommand {
  const size = mark.length;
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    if (options?.needsSelection && state.selection.ranges.every((range) => range.empty)) {
      return false;
    }
    const change = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      if (selected.length >= 2 * size && selected.startsWith(mark) && selected.endsWith(mark)) {
        return {
          changes: [
            { from: range.from, to: range.from + size },
            { from: range.to - size, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - 2 * size),
        };
      }
      const before = state.sliceDoc(Math.max(0, range.from - size), range.from);
      const after = state.sliceDoc(range.to, range.to + size);
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: range.from - size, to: range.from },
            { from: range.to, to: range.to + size },
          ],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + size, range.to + size),
      };
    });
    dispatch(state.update(change, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

/** A plain line becomes an open task, an open task a done one, and a done task opens again. */
const toggleTask: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const changes: ChangeSpec[] = [];
  for (const number of selectedLineNumbers(state)) {
    const line = state.doc.line(number);
    const list = LIST_LINE.exec(line.text);
    const indent = list?.[1] ?? /^\s*/.exec(line.text)?.[0] ?? "";
    const marker = list?.[2];
    if (marker === undefined) {
      changes.push({ from: line.from + indent.length, insert: "- [ ] " });
    } else if (list?.[3] === undefined) {
      changes.push({ from: line.from + indent.length + marker.length, insert: "[ ] " });
    } else {
      const column = indent.length + marker.length + 1;
      changes.push({
        from: line.from + column,
        to: line.from + column + 1,
        insert: line.text[column] === " " ? "x" : " ",
      });
    }
  }
  if (changes.length === 0) return false;
  dispatch(state.update({ changes, userEvent: "input.task" }));
  return true;
};

/**
 * Bold needs a selection, as in the message box: with a bare caret the chord
 * stays the app's sidebar toggle. Strikethrough has no chord there, and the
 * usual one (Mod-Shift-x) is the app's workspace picker, so it takes Mod-Alt-x.
 */
export const formatKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: toggleInlineMark("**", { needsSelection: true }) },
  { key: "Mod-i", run: toggleInlineMark("*") },
  { key: "Mod-e", run: toggleInlineMark("`") },
  { key: "Mod-Alt-x", run: toggleInlineMark("~~") },
  { key: "Mod-l", run: toggleTask },
];

function inCodeBlock(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node !== null) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
    node = node.parent;
  }
  return false;
}

/**
 * Tab nests a list item under the one above: it moves in by the width of its
 * own marker, which lines it up with that item's text. Shift-Tab moves it back.
 * In prose Tab does nothing, since leading spaces there would start a code block.
 */
function shiftListItems(direction: 1 | -1): StateCommand {
  return (target) => {
    const { state, dispatch } = target;
    if (state.readOnly) return false;
    const numbers = selectedLineNumbers(state);
    const lists = numbers.map((number) => LIST_LINE.exec(state.doc.line(number).text));
    if (lists.every((list) => list === null)) {
      if (!inCodeBlock(state, state.selection.main.head)) return true;
      return direction === 1 ? indentMore(target) : indentLess(target);
    }
    const changes: ChangeSpec[] = [];
    numbers.forEach((number, index) => {
      const line = state.doc.line(number);
      const width = (lists[index]?.[2] ?? "  ").length;
      if (direction === 1) {
        changes.push({ from: line.from, insert: " ".repeat(width) });
        return;
      }
      const indent = /^ */.exec(line.text)?.[0].length ?? 0;
      if (indent > 0) changes.push({ from: line.from, to: line.from + Math.min(indent, width) });
    });
    if (changes.length > 0) dispatch(state.update({ changes, userEvent: "input.indent" }));
    return true;
  };
}

export const listKeymap: readonly KeyBinding[] = [
  { key: "Tab", run: shiftListItems(1) },
  { key: "Shift-Tab", run: shiftListItems(-1) },
];
