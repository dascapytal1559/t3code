/** `mixed` also covers lone carriage returns: anything that is not purely LF or purely CRLF. */
export type LineEnding = "lf" | "crlf" | "mixed";

export function lineEndingOf(text: string): LineEnding {
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
