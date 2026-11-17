import { describe, expect, it } from "vite-plus/test";

import { emphasisColor, emphasisPositions, isTopLeague } from "./usageEmphasis";

const rounded = (values: readonly number[]) => values.map((value) => Number(value.toFixed(2)));

describe("emphasisPositions", () => {
  it("places figures by order of magnitude between the smallest and the largest", () => {
    expect(rounded(emphasisPositions([11_100_000_000, 336_000_000, 103_000_000]))).toEqual([
      1, 0.25, 0,
    ]);
  });

  it("keeps figures of similar size together instead of stretching them apart", () => {
    const positions = emphasisPositions([5_000_000_000, 4_600_000_000, 3_900_000_000]);

    expect(rounded(positions)).toEqual([1, 0.96, 0.89]);
    expect(positions.every(isTopLeague)).toBe(true);
  });

  it("puts every figure in the largest one's league in the top league", () => {
    const positions = emphasisPositions([6_200_000_000, 4_100_000_000, 310_000_000, 95_000_000]);

    expect(positions.map(isTopLeague)).toEqual([true, true, false, false]);
  });

  it("holds a lone figure at full strength and an empty one at the floor", () => {
    expect(emphasisPositions([42])).toEqual([1]);
    expect(emphasisPositions([1_000, 0])).toEqual([1, 0]);
    expect(emphasisPositions([0, 0])).toEqual([1, 1]);
  });
});

describe("emphasisColor", () => {
  it("fades from the full text colour down to the floor", () => {
    expect(emphasisColor(1)).toBe("color-mix(in oklab, var(--foreground) 100%, var(--background))");
    expect(emphasisColor(0)).toBe("color-mix(in oklab, var(--foreground) 70%, var(--background))");
  });
});
