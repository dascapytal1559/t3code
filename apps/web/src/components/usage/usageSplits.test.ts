import type { MergedUsage, SplitAmount } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { chartBands, deviceBox, foldMembers } from "./usageSplits";

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
  it("lists rows and children largest first, and draws an opened parent's children", () => {
    const box = deviceBox(usage, "tokens", false);

    expect(box.groups.map((group) => [group.key, group.totalTokens])).toEqual([
      ["computer", 250],
      ["phone", 40],
    ]);
    expect(box.groups[0]!.children.map((child) => child.key)).toEqual([
      "computerOrchestrated",
      "computerDirect",
    ]);
    // A parent's value in a day is its children's.
    expect(box.valueAt(day, "computer", "cost")).toBe(25);
    expect(chartBands(box, new Set()).map((band) => band.key)).toEqual(["computer", "phone"]);
    expect(chartBands(box, new Set(["computer"])).map((band) => band.key)).toEqual([
      "computerOrchestrated",
      "computerDirect",
      "phone",
    ]);
  });

  it("folds the members a kind of work hides into one Others row, or keeps it whole", () => {
    const member = (key: string, totalTokens: number, hidden?: true) => ({
      key,
      totalTokens,
      costUsd: totalTokens * 2,
      ...(hidden === undefined ? {} : { hidden }),
    });
    const bones = [
      member("t3", 5),
      member("fm", 3),
      member("pilot", 2, true),
      member("harness", 1, true),
    ];
    const folded = foldMembers(bones);
    expect(folded.shown.map((entry) => entry.key)).toEqual(["t3", "fm"]);
    expect(folded.others).toEqual({ totalTokens: 3, costUsd: 6 });
    // Showing every member leaves no Others row; showing none keeps the group whole.
    expect(foldMembers([member("t3", 5), member("fm", 3)]).others).toBeNull();
    expect(foldMembers([member("pilot", 2, true)])).toEqual({ shown: [], others: null });
  });
});
