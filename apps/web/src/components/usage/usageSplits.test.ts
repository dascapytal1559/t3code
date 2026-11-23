import type { MergedUsage, SplitAmount } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { chartBands, deviceBox, foldMembers, openedBarBands, processBox } from "./usageSplits";

const amount = (totalTokens: number, costUsd: number): SplitAmount => ({ totalTokens, costUsd });
const day = "2026-11-19";

const processes = new Map([
  ["journal", amount(20, 2)],
  ["routines", amount(40, 4)],
  ["incident", amount(90, 9)],
  ["other", amount(140, 14)],
]);

// Only what the device and process boxes read of merged usage.
const usage = {
  processes: { totals: processes, daily: new Map([[day, processes]]), hourly: new Map() },
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

  it("shows incidents as a fourth process, beside journal, routines and direct", () => {
    const box = processBox(usage, "tokens", false);
    expect(box.groups.map((group) => [group.key, group.totalTokens])).toEqual([
      ["other", 140],
      ["incident", 90],
      ["routines", 40],
      ["journal", 20],
    ]);
    expect(new Set(box.groups.map((group) => group.color)).size).toBe(4);
    expect(box.valueAt(day, "incident", "cost")).toBe(9);
  });

  it("sums the members a kind of work hides into a remainder with no row, or keeps it whole", () => {
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
    expect(folded.remainder).toEqual({ totalTokens: 3, costUsd: 6 });
    // Showing every member leaves no remainder; showing none keeps the group whole.
    expect(foldMembers([member("t3", 5), member("fm", 3)]).remainder).toBeNull();
    expect(foldMembers([member("pilot", 2, true)])).toEqual({ shown: [], remainder: null });
  });

  it("ends an opened parent's bar with its hidden members as an unlabelled grey segment", () => {
    const child = {
      key: "t3",
      label: "t3",
      named: true,
      color: "red",
      totalTokens: 5,
      costUsd: 10,
    };
    const bones = {
      ...child,
      key: "Bones",
      totalTokens: 8,
      costUsd: 16,
      children: [child],
    };
    expect(openedBarBands(bones)).toEqual([child]);
    const withRemainder = openedBarBands({ ...bones, remainder: amount(3, 6) });
    expect(withRemainder.map((band) => [band.key, band.label, band.totalTokens])).toEqual([
      ["t3", "t3", 5],
      ["remainder:Bones", "", 3],
    ]);
  });
});
