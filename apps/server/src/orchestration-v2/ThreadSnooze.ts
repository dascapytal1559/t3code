import * as DateTime from "effect/DateTime";

interface SnoozeFields {
  readonly snoozedUntil?: DateTime.Utc | null | undefined;
  readonly snoozedAt?: DateTime.Utc | null | undefined;
}

/** A dated snooze keeps `snoozedUntil` after its wake time passes; an undated one only has `snoozedAt`. */
export const hasSnoozeRecord = (thread: SnoozeFields): boolean =>
  thread.snoozedUntil != null || thread.snoozedAt != null;

/** An undated snooze holds until the user unsnoozes it. */
export const snoozeHolds = (thread: SnoozeFields, nowMs: number): boolean =>
  thread.snoozedUntil != null
    ? DateTime.toEpochMillis(thread.snoozedUntil) > nowMs
    : thread.snoozedAt != null;
