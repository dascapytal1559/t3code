import { describe, expect, it } from "vite-plus/test";

import {
  axisLabelIndices,
  barGeometry,
  buildPeriodColumns,
  stackedPeak,
} from "./UsageProviderChart";

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const values = new Map([
    [
      "2026-08-01",
      new Map([
        ["codex", 10],
        ["claude", 20],
        ["pi", 5],
        ["muse", 7],
      ]),
    ],
    ["2026-08-03", new Map([["claude", 5]])],
  ]);
  const valueAt = (period: string, key: string) => values.get(period)?.get(key) ?? 0;
  const series = (keys: readonly string[]) =>
    keys.map((key) => ({ key, label: key, color: "red" }));

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, series(["codex", "claude", "grok", "pi"]), valueAt);

    expect(first?.bands).toEqual([
      { key: "codex", value: 10 },
      { key: "claude", value: 20 },
      { key: "grok", value: 0 },
      { key: "pi", value: 5 },
    ]);
  });

  it("scales to the tallest stacked bar of the shown series", () => {
    const shown = (keys: readonly string[]) =>
      stackedPeak(buildPeriodColumns(days, series(keys), valueAt));

    expect(shown(["codex", "claude", "pi", "muse"])).toBe(42);
    expect(shown(["claude"])).toBe(20);
  });
});

describe("axisLabelIndices", () => {
  it("labels at most five buckets and always the latest", () => {
    expect(axisLabelIndices(365)).toEqual([0, 91, 182, 273, 364]);
    expect(axisLabelIndices(30)).toEqual([5, 13, 21, 29]);
    expect(axisLabelIndices(7)).toEqual([0, 2, 4, 6]);
    expect(axisLabelIndices(1)).toEqual([0]);
    expect(axisLabelIndices(0)).toEqual([]);
  });
});

describe("barGeometry", () => {
  it("narrows gaps as bars multiply and drops them at a year of days", () => {
    const week = barGeometry(7);
    expect(week.width).toBe(64);
    expect(week.inset * 2 + week.width).toBeCloseTo(week.step);

    const month = barGeometry(30);
    expect(month.width).toBeLessThan(month.step);

    const year = barGeometry(365);
    expect(year.width).toBe(year.step);
  });
});
