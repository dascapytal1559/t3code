import { describe, expect, it } from "vite-plus/test";

import { orderBands } from "./usageSplitBands";

const band = (key: string, totalTokens: number, costUsd = totalTokens) => ({
  key,
  totalTokens,
  costUsd,
  groupIndex: null,
});

describe("orderBands", () => {
  it("lists bands largest first by the metric", () => {
    const bands = [band("journal", 5, 50), band("routines", 30, 1), band("other", 10, 10)];
    expect(orderBands("process", bands, "tokens").map((b) => b.key)).toEqual([
      "routines",
      "other",
      "journal",
    ]);
    expect(orderBands("process", bands, "cost").map((b) => b.key)).toEqual([
      "journal",
      "other",
      "routines",
    ]);
  });

  it("keeps a device's bands together, the larger device first", () => {
    // The largest single band is the phone's, but the computer is larger overall.
    const bands = [
      band("phoneDirect", 2),
      band("phoneOrchestrated", 40),
      band("computerDirect", 30),
      band("computerOrchestrated", 25),
    ];
    expect(orderBands("device", bands, "tokens").map((b) => b.key)).toEqual([
      "computerDirect",
      "computerOrchestrated",
      "phoneOrchestrated",
      "phoneDirect",
    ]);
  });
});
