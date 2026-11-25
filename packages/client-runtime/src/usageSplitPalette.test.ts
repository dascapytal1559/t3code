import { describe, expect, it } from "vite-plus/test";

import {
  WORK_GROUP_PALETTE,
  usageSplitColorOfHex,
  usageSplitHex,
  workGroupColors,
} from "./usageSplitPalette.ts";

const ground = { foreground: "#000000", background: "#ffffff" };

describe("usageSplitHex", () => {
  it("draws an oklch hue in sRGB, a little lighter in dark mode", () => {
    const red = { lightness: 0.627955, chroma: 0.257683, hue: 29.233885 };
    expect(usageSplitHex(red, false, ground)).toBe("#ff0000");
    expect(usageSplitHex({ lightness: 0.5, chroma: 0, hue: 0 }, false, ground)).toBe("#636363");
    expect(usageSplitHex({ lightness: 0.5, chroma: 0, hue: 0 }, true, ground)).toBe("#7a7a7a");
  });

  it("mixes a grey from the foreground over the background in oklab, as CSS color-mix does", () => {
    expect(usageSplitHex({ ink: 0 }, false, ground)).toBe("#ffffff");
    expect(usageSplitHex({ ink: 100 }, false, ground)).toBe("#000000");
    expect(usageSplitHex({ ink: 50 }, false, ground)).toBe("#636363");
  });

  it("draws a member's own hex colour as given in light mode, and lighter in dark mode", () => {
    for (const hex of ["#1b4ed8", "#d9a747", "#a84c21"]) {
      expect(usageSplitHex(usageSplitColorOfHex(hex), false, ground)).toBe(hex);
    }
    expect(usageSplitHex(usageSplitColorOfHex("#1b4ed8"), true, ground)).toBe("#3169f4");
  });
});

describe("workGroupColors", () => {
  it("takes the palette's entry by the group's order when the group has no colour", () => {
    expect(workGroupColors(1, undefined)).toBe(WORK_GROUP_PALETTE[1]);
    expect(workGroupColors(WORK_GROUP_PALETTE.length, undefined)).toBe(WORK_GROUP_PALETTE[0]);
  });

  it("draws a group's own colour, and gives its members shades of it", () => {
    const green = workGroupColors(1, "#4a8a2c");
    expect(usageSplitHex(green.color, false, ground)).toBe("#4a8a2c");
    if ("ink" in green.color) throw new Error("expected a hue");
    const own = green.color;
    expect(green.members).toHaveLength(3);
    for (const member of green.members) {
      if ("ink" in member) throw new Error("expected a hue");
      // Close in hue, as the palette's members are to their group, so a green's read as greens.
      const turn = Math.abs(((member.hue - own.hue + 540) % 360) - 180);
      expect(turn).toBeLessThanOrEqual(15);
      expect(member.lightness).not.toBe(own.lightness);
    }
    expect(new Set(green.members.map((member) => usageSplitHex(member, false, ground))).size).toBe(
      3,
    );
  });
});
