import { EditorSelection, EditorState, type Extension } from "@codemirror/state";

/** `mixed` also covers lone carriage returns: anything that is not purely LF or purely CRLF. */
export type LineEnding = "lf" | "crlf" | "mixed";

/** A text with no line break keeps `previous`, the line ending of the file it replaces. */
export function lineEndingOf(text: string, previous: LineEnding = "lf"): LineEnding {
  if (!/[\r\n]/.test(text)) return previous;
  if (!text.includes("\r")) return "lf";
  return /\r(?!\n)|(?<!\r)\n/.test(text) ? "mixed" : "crlf";
}

/**
 * The editor counts every line break as one character. A CRLF file is held
 * with plain breaks and gets its own back on the way out; a mixed file keeps
 * its carriage returns as ordinary characters. Either way the file's bytes
 * round-trip.
 */
export function toEditorText(text: string, ending: LineEnding): string {
  return ending === "crlf" ? text.replaceAll("\r\n", "\n") : text;
}

export function fromEditorText(text: string, ending: LineEnding): string {
  return ending === "crlf" ? text.replaceAll("\n", "\r\n") : text;
}

/** A mixed file names its separator, which keeps its carriage returns as text. */
export const mixedLineEndings: Extension = [
  EditorState.lineSeparator.of("\n"),
  EditorState.transactionFilter.of((tr) => {
    const { newDoc: doc, newSelection: selection } = tr;
    const inside = (pos: number) =>
      pos > 0 && doc.lineAt(pos).to === pos && doc.sliceString(pos - 1, pos) === "\r"
        ? pos - 1
        : pos;
    const ranges = selection.ranges.map((range) =>
      EditorSelection.range(inside(range.anchor), inside(range.head)),
    );
    if (ranges.every((range, index) => range.eq(selection.ranges[index]!))) return tr;
    return [
      tr,
      { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true },
    ];
  }),
];
