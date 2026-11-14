import type { MergedOrigins, OriginTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { originAxes } from "./usageOriginAxes";

const row = (origin: OriginTotals["origin"], bases: OriginTotals["bases"]): OriginTotals => ({
  origin,
  prompts: 0,
  costUsd: 0,
  totalTokens: 0,
  bases,
});
const basis = (
  name: OriginTotals["bases"][number]["basis"],
  totalTokens: number,
  extra: { prompts?: number; via?: "agent" | "crew" } = {},
) => ({
  basis: name,
  prompts: extra.prompts ?? 1,
  costUsd: totalTokens / 1000,
  totalTokens,
  ...extra,
});

describe("originAxes", () => {
  it("places each origin row by device and by who sent it, keeping every leftover", () => {
    const origins: MergedOrigins = {
      rows: [
        row("phone", [
          basis("stamp", 600),
          basis("nativeApp", 50),
          basis("stamp", 300, { via: "crew" }),
        ]),
        row("computer", [basis("stamp", 900), basis("stamp", 1, { via: "agent" })]),
        row("agent", [basis("notification", 400), basis("sender", 70), basis("stamp", 30)]),
        row("crew", [basis("sender", 1000), basis("notification", 100)]),
        row("unknown", [
          basis("unstamped", 150),
          basis("server", 0, { prompts: 9 }),
          basis("stamp", 5),
          basis("noPrompt", 20),
        ]),
      ],
      unlinkedCostUsd: 3,
      unlinkedTokens: 3000,
    };
    const axes = originAxes(origins);

    expect(axes.devices.phone.direct.totalTokens).toBe(650);
    expect(axes.devices.phone.coordinated.totalTokens).toBe(300);
    expect(axes.devices.computer.direct.totalTokens).toBe(900);
    expect(axes.devices.computer.coordinated.totalTokens).toBe(1);
    // A background-task update is its own reason, in a crew thread or not.
    expect(axes.unrecorded.coordinated.reasons.map((r) => [r.reason, r.totalTokens])).toEqual([
      ["crew", 1000],
      ["notification", 500],
      ["agent", 100],
    ]);
    expect(axes.unrecorded.direct.reasons.map((r) => [r.reason, r.totalTokens, r.prompts])).toEqual(
      [
        ["unstamped", 150, 1],
        ["stampedUnknown", 5, 1],
        ["server", 0, 9],
      ],
    );
    expect(axes.unrecorded.direct.totalTokens).toBe(155);
    expect(axes.promptGone.totalTokens).toBe(20);
    expect(axes.outside).toEqual({ costUsd: 3, totalTokens: 3000 });

    const placed =
      axes.devices.phone.direct.totalTokens +
      axes.devices.phone.coordinated.totalTokens +
      axes.devices.computer.direct.totalTokens +
      axes.devices.computer.coordinated.totalTokens +
      axes.unrecorded.direct.totalTokens +
      axes.unrecorded.coordinated.totalTokens +
      axes.promptGone.totalTokens;
    const linked = origins.rows.flatMap((r) => r.bases).reduce((sum, b) => sum + b.totalTokens, 0);
    expect(placed).toBe(linked);
  });
});
