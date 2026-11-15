import {
  type ChangeSpec,
  EditorSelection,
  EditorState,
  type Extension,
  Transaction,
} from "@codemirror/state";

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
    if (!tr.docChanged || !tr.isUserEvent("input")) return tr;
    const doc = tr.startState.doc;
    const afterLineEndCr = (pos: number) =>
      pos > 0 && doc.lineAt(pos).to === pos && doc.sliceString(pos - 1, pos) === "\r";
    const changes: ChangeSpec[] = [];
    const movedEnds: number[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
      const moves =
        fromA === toA &&
        inserted.length > 0 &&
        inserted.sliceString(0, 1) !== "\n" &&
        afterLineEndCr(fromA);
      if (moves) movedEnds.push(toB);
      changes.push(
        moves ? { from: fromA - 1, insert: inserted } : { from: fromA, to: toA, insert: inserted },
      );
    });
    if (movedEnds.length === 0) return tr;
    const at = (pos: number) => (movedEnds.includes(pos) ? pos - 1 : pos);
    const selection = tr.newSelection;
    return {
      changes,
      selection: EditorSelection.create(
        selection.ranges.map((range) => EditorSelection.range(at(range.anchor), at(range.head))),
        selection.mainIndex,
      ),
      effects: tr.effects,
      scrollIntoView: tr.scrollIntoView,
      userEvent: tr.annotation(Transaction.userEvent) ?? "input",
    };
  }),
];
