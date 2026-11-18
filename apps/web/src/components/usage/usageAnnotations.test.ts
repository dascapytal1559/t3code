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
  const base = { periodCount: 10, plotWidth: 1000, plotHeight: 200, chipHeight: 20 };

  it("sits a chip just above the tallest bar it spans, in the plot's upper part", () => {
    const barTop = (index: number) => (index === 5 ? 50 : 180);
    expect(layoutAnnotationChips({ ...base, chips: [{ index: 4, width: 120 }], barTop })).toEqual([
      { left: 390, top: 24, x: 450 },
    ]);
    expect(layoutAnnotationChips({ ...base, chips: [{ index: 0, width: 120 }], barTop })).toEqual([
      { left: 0, top: 60, x: 50 },
    ]);
  });

  it("keeps chips inside the plot and lifts one above an earlier chip it would overlap", () => {
    const layout = layoutAnnotationChips({
      ...base,
      chips: [
        { index: 8, width: 120 },
        { index: 9, width: 120 },
      ],
      barTop: () => 190,
    });
    expect(layout).toEqual([
      { left: 790, top: 60, x: 850 },
      { left: 880, top: 34, x: 950 },
    ]);
  });

  it("sets a chip beside its line when the bars under its centre reach the top", () => {
    const barTop = (index: number) => (index === 6 ? 4 : 180);
    expect(layoutAnnotationChips({ ...base, chips: [{ index: 5, width: 120 }], barTop })).toEqual([
      { left: 440, top: 60, x: 550 },
    ]);
  });

  it("covers a bar only when the plot leaves no room above it", () => {
    expect(
      layoutAnnotationChips({ ...base, chips: [{ index: 2, width: 80 }], barTop: () => 4 }),
    ).toEqual([{ left: 210, top: 0, x: 250 }]);
  });
});
