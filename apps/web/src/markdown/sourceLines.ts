import type { Element, ElementContent, Root } from "hast";
import { splitMarkdown } from "@t3tools/shared/markdownChunks";

const isElement = (node: Root["children"][number] | ElementContent): node is Element =>
  node.type === "element";

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }
  return starts;
}

/** The 1-based line holding `offset`. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** The lines of a piece that hold text, as `first-last`, from the piece's first line. */
function occupiedLines(piece: string, firstLine: number): string | null {
  const lines = piece.split("\n");
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start === -1) return null;
  const end = lines.findLastIndex((line) => line.trim() !== "");
  return `${firstLine + start}-${firstLine + end}`;
}

function markPositioned(node: Root | Element, starts: readonly number[]) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    const { position } = child;
    if ((child.tagName === "li" || child.tagName === "pre") && position) {
      const end = Math.max(position.start.offset!, position.end.offset! - 1);
      child.properties.dataSourceLines = `${lineAt(starts, position.start.offset!)}-${lineAt(starts, end)}`;
    }
    markPositioned(child, starts);
  }
}

/**
 * Fork: marks blocks with the source lines they came from, so a selection in a rendered file can
 * be cited. Words positions only list items and code, so each top-level block takes its lines
 * from the piece of source that renders it. If the pieces do not add up to the tree's blocks,
 * those blocks stay unmarked and citing falls back to the lines between the marked ones.
 */
export function markSourceLines(
  tree: Root,
  text: string,
  blocksIn: (piece: string) => number,
): void {
  const blocks = tree.children.filter(isElement);
  const assigned: Array<readonly [Element, string]> = [];
  let line = 1;
  let next = 0;
  for (const { text: piece, lines } of splitMarkdown(text, 1).chunks) {
    const count = blocksIn(piece);
    const range = occupiedLines(piece, line);
    for (const block of blocks.slice(next, next + count)) {
      if (range !== null) assigned.push([block, range]);
    }
    next += count;
    line += lines;
  }
  if (next === blocks.length) {
    for (const [block, range] of assigned) block.properties.dataSourceLines = range;
  }
  markPositioned(tree, lineStarts(text));
}
