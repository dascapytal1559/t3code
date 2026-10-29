const SKIPPED_RECORDS =
  /\s*\d+ malformed or inconsistent usage record\(s\) were skipped; usage may be incomplete\.$/;

/**
 * Fork feature: splits upstream's skipped-records sentence, which the server
 * appends to a source message, so the page can show it as a footnote.
 */
export function splitSkippedRecords(message: string): {
  readonly notice: string | null;
  readonly skipped: string | null;
} {
  const match = SKIPPED_RECORDS.exec(message);
  if (match === null) return { notice: message, skipped: null };
  const notice = message.slice(0, match.index).trim();
  return { notice: notice === "" ? null : notice, skipped: match[0].trim() };
}
