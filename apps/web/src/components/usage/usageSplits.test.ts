import type { MergedUsage, SplitAmount } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  chartBands,
  deviceBox,
  foldMembers,
  openedBarBands,
  processBox,
  shownBreakdowns,
  speedBox,
  workBox,
} from "./usageSplits";

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
  it("splits cost by speed, shown after direction only in the cost view and only with faster usage", () => {
    const speeds = new Map([
      ["standard", amount(900, 30)],
      ["fast", amount(0, 12)],
    ]);
    const box = speedBox(
      {
        speeds: { totals: speeds, daily: new Map([[day, speeds]]), hourly: new Map() },
      } as unknown as MergedUsage,
      false,
    );

    expect(box.groups.map((group) => [group.key, group.costUsd])).toEqual([
      ["standard", 30],
      ["fast", 12],
    ]);
    expect(box.valueAt(day, "fast", "cost")).toBe(12);
    expect(shownBreakdowns("cost", 12)).toEqual([
      "provider",
      "work",
      "device",
      "process",
      "type",
      "speed",
    ]);
    expect(shownBreakdowns("cost", 0)).not.toContain("speed");
    expect(shownBreakdowns("tokens", 12)).not.toContain("speed");
  });

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

  it("colours a kind of work by its own colour, with its members in its shades, else the palette's", () => {
    const work = new Map([
      ["Work", amount(60, 6)],
      ["Environment", amount(40, 4)],
    ]);
    const members = new Map([
      ["Work\u0000app", amount(40, 4)],
      ["Work\u0000site", amount(20, 2)],
      ["Environment\u0000tools", amount(40, 4)],
    ]);
    const workUsage = (workGroupColors: ReadonlyMap<string, string>) =>
      ({
        work: { totals: work, daily: new Map([[day, work]]), hourly: new Map() },
        workGroups: ["Environment", "Work"],
        workGroupColors,
        sharedWork: [],
        workMembers: { totals: members, daily: new Map([[day, members]]), hourly: new Map() },
        workMemberInfo: [
          { key: "app", group: "Work", name: "app" },
          { key: "site", group: "Work", name: "site", color: "#123456" },
          { key: "tools", group: "Environment", name: "tools" },
        ],
      }) as unknown as MergedUsage;
    const colours = (box: ReturnType<typeof workBox>) =>
      Object.fromEntries(
        box.groups.map((group) => [
          group.key,
          [group.color, ...group.children.map((child) => child.color)],
        ]),
      );

    const palette = colours(workBox(workUsage(new Map()), "tokens", false));
    const green = colours(workBox(workUsage(new Map([["Work", "#4a8a2c"]])), "tokens", false));
    // A group with no colour keeps the palette's for its order.
    expect(green.Environment).toEqual(palette.Environment);
    // The green group and its member without a colour of its own change; the member with one keeps it.
    const [group, app, site] = green.Work!;
    expect(group).not.toBe(palette.Work![0]);
    expect(group).toMatch(/^light-dark\(oklch\(0\.5\d+ 0\.1\d+ 13\d/);
    expect(app).not.toBe(palette.Work![1]);
    expect(app).toMatch(/oklch\([\d.]+ [\d.]+ 1[23]\d/);
    expect(site).toBe(palette.Work![2]);
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
