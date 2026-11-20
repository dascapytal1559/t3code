import { UsageDay, type UsageAnnotation } from "@t3tools/contracts";
import { enumerateDays, enumerateHourStarts } from "@t3tools/shared/usageFormat";
import { describe, expect, it } from "vite-plus/test";

import {
  collectUsageAnnotations,
  layoutAnnotationChips,
  placeUsageAnnotations,
} from "./usageAnnotations";

const note = (date: string, label: string, logo?: "t3"): UsageAnnotation => ({
  date: UsageDay.make(date),
  label,
  ...(logo === undefined ? {} : { logo }),
});

describe("collectUsageAnnotations", () => {
  it("keeps one copy of an annotation two servers share, oldest first", () => {
    expect(
      collectUsageAnnotations([
        [note("2026-05-20", "Editor"), note("2026-03-04", "Launch")],
        undefined,
        [note("2026-03-04", "Launch"), note("2026-03-04", "Launch", "t3")],
      ]),
    ).toEqual([
      note("2026-03-04", "Launch"),
      note("2026-03-04", "Launch", "t3"),
      note("2026-05-20", "Editor"),
    ]);
  });
});

describe("placeUsageAnnotations", () => {
  const annotations = [note("2026-03-01", "Before"), note("2026-03-04", "Launch")];

  it("places a day on its own bar and leaves out days outside the range", () => {
    expect(
      placeUsageAnnotations(annotations, enumerateDays("2026-03-02", "2026-03-08"), "day", "UTC"),
    ).toEqual([{ annotation: note("2026-03-04", "Launch"), index: 2 }]);
  });

  it("places a day on the hour holding its midnight in the chart's time zone", () => {
    const hours = enumerateHourStarts("2026-03-03T09:30:00.000Z", "2026-03-04T09:30:00.000Z");
    expect(placeUsageAnnotations(annotations, hours, "hour", "UTC")).toEqual([
      { annotation: note("2026-03-04", "Launch"), index: 14 },
    ]);
    // Midnight in Sydney is 13:00 UTC, in the hour from 12:30.
    expect(placeUsageAnnotations(annotations, hours, "hour", "Australia/Sydney")).toEqual([
      { annotation: note("2026-03-04", "Launch"), index: 3 },
    ]);
    // From 15:30 UTC the window starts after Sydney's midnight, so the day began outside it.
    expect(placeUsageAnnotations(annotations, hours.slice(6), "hour", "Australia/Sydney")).toEqual(
      [],
    );
  });
});

describe("layoutAnnotationChips", () => {
  const base = { periodCount: 10, plotWidth: 1000 };

  it("centres a chip under its date and keeps it inside the plot", () => {
    expect(layoutAnnotationChips({ ...base, chips: [{ index: 4, width: 120 }] })).toEqual([
      { left: 390, row: 0, x: 450 },
    ]);
    expect(layoutAnnotationChips({ ...base, chips: [{ index: 9, width: 120 }] })).toEqual([
      { left: 880, row: 0, x: 950 },
    ]);
  });

  it("moves a chip to the next row only when it would overlap one in the first", () => {
    expect(
      layoutAnnotationChips({
        ...base,
        chips: [
          { index: 1, width: 120 },
          { index: 2, width: 120 },
          { index: 7, width: 120 },
        ],
      }),
    ).toEqual([
      { left: 90, row: 0, x: 150 },
      { left: 190, row: 1, x: 250 },
      { left: 690, row: 0, x: 750 },
    ]);
  });
});
