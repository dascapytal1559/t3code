import type { MergedOrigins, OriginTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { originAxes, originNotes } from "./usageOriginAxes";

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
        row("computer", [
          basis("stamp", 900),
          basis("stamp", 1, { via: "agent" }),
          basis("default", 40),
          basis("default", 8, { via: "crew" }),
        ]),
        row("agent", [basis("notification", 400), basis("sender", 70)]),
        row("crew", [basis("sender", 1000)]),
        row("unknown", [
          basis("unstamped", 150),
          basis("noPrompt", 20),
          basis("beforeOrigins", 5000),
          basis("archive", 700),
        ]),
      ],
      unlinkedCostUsd: 3,
      unlinkedTokens: 3000,
    };

    // Usage with no recorded parent counts to the computer, keeping who sent it.
    expect(originAxes(origins)).toEqual({
      phone: {
        direct: { costUsd: 1300, totalTokens: 650 },
        coordinated: { costUsd: 600, totalTokens: 300 },
      },
      computer: {
        direct: { costUsd: 1880, totalTokens: 940 },
        coordinated: { costUsd: 18, totalTokens: 9 },
      },
    });
    expect(originNotes(origins)).toEqual({
      assumed: { costUsd: 96, totalTokens: 48 },
      beforeOrigins: { costUsd: 10000, totalTokens: 5000 },
      archive: { costUsd: 1400, totalTokens: 700 },
    });
  });
});
