import { describe, expect, it } from "vite-plus/test";

import {
  axisLabelIndices,
  barGeometry,
  buildPeriodColumns,
  stackedPeak,
} from "./UsageProviderChart";

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
      { provider: "pi", value: 5 },
      { provider: "muse", value: 7 },
    ]);
  });

  it("scales to the tallest stacked bar of the shown providers", () => {
    const columns = buildPeriodColumns(days, byDay, "cost");

    expect(stackedPeak(columns, ["codex", "claude", "pi", "muse"])).toBe(42);
    expect(stackedPeak(columns, ["claude"])).toBe(20);
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
