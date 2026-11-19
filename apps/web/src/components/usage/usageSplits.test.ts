import type { MergedUsage, SplitAmount } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { chartBands, deviceBox, type BoxModel } from "./usageSplits";

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

  it("keeps a parent whole when every child it holds is hidden", () => {
    const band = (key: string) => ({
      key,
      label: key,
      named: true,
      color: "",
      totalTokens: 1,
      costUsd: 0,
    });
    const box: BoxModel = {
      kind: "work",
      groups: [
        { ...band("Bones"), children: [band("t3"), band("fm")], hidden: new Set(["t3", "fm"]) },
      ],
      valueAt: () => 0,
    };
    expect(chartBands(box, new Set(["Bones"])).map((entry) => entry.key)).toEqual(["Bones"]);
    // One shown member opens it, and the hidden one keeps its band beside it.
    const shown = { ...box, groups: [{ ...box.groups[0]!, hidden: new Set(["fm"]) }] };
    expect(chartBands(shown, new Set(["Bones"])).map((entry) => entry.key)).toEqual(["t3", "fm"]);
  });
});
