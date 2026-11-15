import { INDEFINITE_SNOOZE_UNTIL, RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(
  resetAt: Date,
  timestampFormat: TimestampFormat,
  snoozedUntil: string | null = null,
) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil,
    recovery:
      snoozedUntil === null
        ? null
        : {
            runId: RunId.make("run-1"),
            resetAt: resetAt.toISOString(),
            autoResume: true,
          },
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });

  it("resumes an indefinitely snoozed thread when it is woken, not on a date", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(
      bannerDescription(new Date(2026, 9, 20, 17, 30), "24-hour", INDEFINITE_SNOOZE_UNTIL),
    ).toBe("Resumes when you wake it");
  });
});
