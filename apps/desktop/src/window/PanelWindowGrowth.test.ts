import { describe, expect, it } from "vite-plus/test";

import { growForPanel, shrinkAfterPanel } from "./PanelWindowGrowth.ts";

const workArea = { x: 0, y: 25, width: 1800, height: 1100 };
const window = (x: number, width: number) => ({ x, y: 100, width, height: 900 });

describe("growForPanel", () => {
  it.each([
    {
      name: "room to the right: grows in place",
      bounds: window(100, 1000),
      expected: {
        bounds: window(100, 1540),
        growth: { added: 540, gaveWay: 0, shiftedLeft: 0, grownX: 100 },
      },
    },
    {
      name: "near the right edge: moves left only as far as needed",
      bounds: window(500, 1000),
      expected: {
        bounds: window(260, 1540),
        growth: { added: 540, gaveWay: 0, shiftedLeft: 240, grownX: 260 },
      },
    },
    {
      name: "screen too narrow: grows as far as it can, the chat gives way for the rest",
      bounds: window(200, 1500),
      expected: {
        bounds: window(0, 1800),
        growth: { added: 300, gaveWay: 240, shiftedLeft: 200, grownX: 0 },
      },
    },
    {
      name: "already as wide as the screen: no change",
      bounds: window(0, 1800),
      expected: null,
    },
  ])("$name", ({ bounds, expected }) => {
    expect(growForPanel(bounds, workArea, 540)).toEqual(expected);
  });

  it("respects a work area that starts right of zero", () => {
    expect(growForPanel(window(2500, 1000), { ...workArea, x: 1800 }, 540)?.bounds).toEqual(
      window(1800 + 1800 - 1540, 1540),
    );
  });
});

describe("shrinkAfterPanel", () => {
  const grow = (bounds: ReturnType<typeof window>) => {
    const result = growForPanel(bounds, workArea, 540);
    if (result === null) throw new Error("expected growth");
    return result;
  };

  it.each([
    { name: "in place", start: window(100, 1000) },
    { name: "after moving left at the edge", start: window(500, 1000) },
    { name: "after a partial grow on a narrow screen", start: window(200, 1500) },
  ])("returns to the starting bounds $name", ({ start }) => {
    const { bounds, growth } = grow(start);
    expect(shrinkAfterPanel(bounds, growth, 540, 840)).toEqual(start);
  });

  it.each([
    { name: "wider", resized: 1740, panel: 740 },
    { name: "narrower", resized: 1390, panel: 390 },
  ])("takes a hand resize back with the panel it went to ($name)", ({ resized, panel }) => {
    const { growth } = grow(window(100, 1000));
    expect(shrinkAfterPanel(window(100, resized), growth, panel, 840)).toEqual(window(100, 1000));
  });

  it("gives the chat back what it gave up after a partial grow", () => {
    const { growth } = grow(window(200, 1500));
    expect(shrinkAfterPanel(window(0, 1700), growth, 440, 840)).toEqual(window(200, 1500));
  });

  it("leaves a window moved by hand where it is", () => {
    const { growth } = grow(window(500, 1000));
    expect(shrinkAfterPanel(window(50, 1540), growth, 540, 840)).toEqual(window(50, 1000));
  });

  it("stops at the minimum width and moves back only by what it removed", () => {
    const { growth } = grow(window(500, 1000));
    expect(shrinkAfterPanel(window(260, 1200), growth, 540, 840)).toEqual(window(500, 840));
    expect(shrinkAfterPanel(window(260, 900), growth, 540, 840)).toEqual(window(320, 840));
  });
});
