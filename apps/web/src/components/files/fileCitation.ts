import type { EnvironmentId, FileCitation } from "@t3tools/contracts";

/** 1-based source lines, inclusive. */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export function buildFileCitation(input: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly lines: LineRange;
  readonly text: string;
}): FileCitation | null {
  if (input.text.trim().length === 0 || input.path.length === 0) return null;
  const { startLine, endLine } = input.lines;
  return {
    environmentId: input.environmentId,
    path: input.path,
    startLine: Math.max(1, Math.min(startLine, endLine)),
    endLine: Math.max(1, startLine, endLine),
    text: input.text,
  };
}

/**
 * The lines an editor selection of `[from, to)` covers. A selection that ends at the start of a
 * line, as a triple click or a drag to the left margin leaves it, does not take that line.
 */
export function editorSelectionLines(
  doc: { lineAt: (position: number) => { number: number; from: number } },
  from: number,
  to: number,
): LineRange {
  const start = doc.lineAt(from).number;
  const end = doc.lineAt(to);
  return {
    startLine: start,
    endLine: to > from && end.number > start && end.from === to ? end.number - 1 : end.number,
  };
}

export function splitSourceLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

/** One end of a selection in the rendered view: the block it falls in and where in its text. */
export interface RenderedSelectionEnd {
  /** The source lines the block was parsed from. */
  readonly block: LineRange;
  /** The block's rendered text. */
  readonly text: string;
  /** The selection end's offset into `text`. */
  readonly offset: number;
}

const WORD = /[\p{L}\p{N}]+/gu;

function renderedWords(text: string) {
  return Array.from(text.matchAll(WORD), (match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

const LINK_DESTINATION = /\]\([^)]*\)/g;
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g;

/**
 * The source line of the rendered word at `index`, found by matching the block's rendered words in
 * order against its source words, with link targets and HTML tags left out. Other markup only adds
 * words, so rendered words stay in order among them; a rendered word the source lacks gives up.
 */
function alignedLine(
  lines: readonly string[],
  block: LineRange,
  words: ReadonlyArray<{ word: string }>,
  index: number,
): number | null {
  const source: { word: string; line: number }[] = [];
  for (let line = block.startLine; line <= block.endLine; line += 1) {
    const text = (lines[line - 1] ?? "").replace(LINK_DESTINATION, "]").replace(HTML_TAG, " ");
    for (const match of text.matchAll(WORD)) {
      source.push({ word: match[0].toLowerCase(), line });
    }
  }
  let cursor = 0;
  for (let wordIndex = 0; wordIndex <= index; wordIndex += 1) {
    const word = words[wordIndex]!.word;
    while (cursor < source.length && source[cursor]!.word !== word) cursor += 1;
    if (cursor === source.length) return null;
    if (wordIndex === index) return source[cursor]!.line;
    cursor += 1;
  }
  return null;
}

function contentLine(lines: readonly string[], from: number, step: 1 | -1): number {
  let line = from;
  while (line >= 1 && line <= lines.length && (lines[line - 1] ?? "").trim() === "") line += step;
  return line;
}

/**
 * The source lines a selection in the rendered view covers. Each end maps to the line its first
 * or last selected word came from. An end past all of its block's words, as a triple click leaves
 * it, sits on the boundary with the neighbouring block; an end that cannot be placed takes its
 * whole block.
 */
export function renderedSelectionLines(
  lines: readonly string[],
  start: RenderedSelectionEnd,
  end: RenderedSelectionEnd,
): LineRange {
  const startWords = renderedWords(start.text);
  const first = startWords.findIndex((word) => word.end > start.offset);
  const startLine =
    first === -1
      ? startWords.length === 0
        ? start.block.startLine
        : contentLine(lines, start.block.endLine + 1, 1)
      : (alignedLine(lines, start.block, startWords, first) ?? start.block.startLine);
  const endWords = renderedWords(end.text);
  const last = endWords.findLastIndex((word) => word.start < end.offset);
  const endLine =
    last === -1
      ? endWords.length === 0
        ? end.block.endLine
        : contentLine(lines, end.block.startLine - 1, -1)
      : (alignedLine(lines, end.block, endWords, last) ?? end.block.endLine);
  return startLine <= endLine
    ? { startLine, endLine }
    : { startLine: start.block.startLine, endLine: end.block.endLine };
}
