export type LineEnding = "lf" | "crlf";

/**
 * The line ending a file is written with: CRLF when most of its breaks are
 * CRLF, else LF, as editors such as VS Code settle a file that mixes them. A
 * text with no line break keeps `previous`, the ending of the file it replaces.
 */
export function lineEndingOf(text: string, previous: LineEnding = "lf"): LineEnding {
  const breaks = text.match(/\r\n|\r|\n/g);
  if (breaks === null) return previous;
  const crlf = breaks.filter((lineBreak) => lineBreak === "\r\n").length;
  return crlf * 2 > breaks.length ? "crlf" : "lf";
}

/** The editor holds every line break as `\n`; the file gets its ending back on the way out. */
export function toEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function fromEditorText(text: string, ending: LineEnding): string {
  return ending === "crlf" ? text.replaceAll("\n", "\r\n") : text;
}
