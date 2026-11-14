import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState, StateCommand } from "@codemirror/state";
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
