/** `mixed` also covers lone carriage returns: anything that is not purely LF or purely CRLF. */
export type LineEnding = "lf" | "crlf" | "mixed";

const BYTE_ORDER_MARK = "﻿";

/** How a file's bytes differ from the editor's text: its line breaks, and a leading byte order mark. */
export interface FileFormat {
  readonly ending: LineEnding;
  readonly bom: boolean;
}

function lineEndingOf(text: string): LineEnding {
  if (!text.includes("\r")) return "lf";
  return /\r(?!\n)|(?<!\r)\n/.test(text) ? "mixed" : "crlf";
}

/** A text with no line break keeps the line ending of the file it replaces. */
export function fileFormatOf(text: string, previous?: FileFormat): FileFormat {
  const ending = previous && !/[\r\n]/.test(text) ? previous.ending : lineEndingOf(text);
  return { ending, bom: text.startsWith(BYTE_ORDER_MARK) };
}

/**
 * The editor counts every line break as one character. A CRLF file is held with
 * plain breaks and gets its own back on the way out; a mixed file keeps its carriage
 * returns as ordinary characters. Either way the file's bytes round-trip.
 */
export function toEditorText(text: string, format: FileFormat): string {
  const body = format.bom ? text.slice(BYTE_ORDER_MARK.length) : text;
  return format.ending === "crlf" ? body.replaceAll("\r\n", "\n") : body;
}

export function fromEditorText(text: string, format: FileFormat): string {
  const body = format.ending === "crlf" ? text.replaceAll("\n", "\r\n") : text;
  return format.bom ? BYTE_ORDER_MARK + body : body;
}
