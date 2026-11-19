import type { MergedUsage, SplitAmount } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { chartBands, deviceBox } from "./usageSplits";

const amount = (totalTokens: number, costUsd: number): SplitAmount => ({ totalTokens, costUsd });
const day = "2026-11-19";

// Only what the device box reads of merged usage.
const usage = {
  devices: {
    totals: new Map([
      ["phoneDirect", amount(10, 1)],
      ["phoneOrchestrated", amount(30, 3)],
      ["computerDirect", amount(50, 5)],
      ["computerOrchestrated", amount(200, 20)],
    ]),
    daily: new Map([
      [
        day,
        new Map([
          ["phoneDirect", amount(10, 1)],
          ["phoneOrchestrated", amount(30, 3)],
          ["computerDirect", amount(50, 5)],
          ["computerOrchestrated", amount(200, 20)],
        ]),
      ],
    ]),
    hourly: new Map(),
  },
} as unknown as MergedUsage;

describe("breakdown boxes", () => {
  it("draws parents until one opens, then that parent's children in the card's order", () => {
    const box = deviceBox(usage, "tokens", false);

    expect(box.groups.map((group) => [group.key, group.totalTokens])).toEqual([
      ["phone", 40],
      ["computer", 250],
    ]);
    // A parent's value in a day is its children's.
    expect(box.valueAt(day, "computer", "cost")).toBe(25);
    expect(chartBands(box, new Set()).map((band) => band.key)).toEqual(["phone", "computer"]);
    expect(chartBands(box, new Set(["computer"])).map((band) => band.key)).toEqual([
      "phone",
      "computerDirect",
      "computerOrchestrated",
    ]);
  });
});
