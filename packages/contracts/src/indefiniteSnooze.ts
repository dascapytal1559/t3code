// Fork: an indefinite snooze stores a wake time no clock reaches, so every
// "snoozed while snoozedUntil is in the future" check holds it until a wake.
export const INDEFINITE_SNOOZE_UNTIL = "9999-12-31T23:59:59.000Z";

const INDEFINITE_SNOOZE_UNTIL_MS = Date.parse(INDEFINITE_SNOOZE_UNTIL);

/** Whether a stored wake time (ISO string or epoch ms) is the indefinite marker. */
export function isIndefiniteSnooze(snoozedUntil: string | number | null | undefined): boolean {
  if (snoozedUntil == null) return false;
  const wakeMs = typeof snoozedUntil === "number" ? snoozedUntil : Date.parse(snoozedUntil);
  return wakeMs >= INDEFINITE_SNOOZE_UNTIL_MS;
}
