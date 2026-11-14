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
  extra: { via?: "agent" | "crew" } = {},
) => ({
  basis: name,
  prompts: 1,
  costUsd: totalTokens * 2,
  totalTokens,
  ...extra,
});

describe("originAxes", () => {
  it("splits each device by who sent it and leaves out usage with no device", () => {
    const origins: MergedOrigins = {
      rows: [
        row("phone", [
          basis("stamp", 600),
          basis("nativeApp", 50),
          basis("stamp", 300, { via: "crew" }),
        ]),
        row("computer", [basis("stamp", 900), basis("stamp", 1, { via: "agent" })]),
        row("agent", [basis("notification", 400), basis("sender", 70)]),
        row("crew", [basis("sender", 1000)]),
        row("unknown", [basis("unstamped", 150), basis("noPrompt", 20)]),
      ],
      unlinkedCostUsd: 3,
      unlinkedTokens: 3000,
    };

    expect(originAxes(origins)).toEqual({
      phone: {
        direct: { costUsd: 1300, totalTokens: 650 },
        coordinated: { costUsd: 600, totalTokens: 300 },
      },
      computer: {
        direct: { costUsd: 1800, totalTokens: 900 },
        coordinated: { costUsd: 2, totalTokens: 1 },
      },
    });
  });
});
