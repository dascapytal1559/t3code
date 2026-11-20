import { describe, expect, it } from "vite-plus/test";

import { usageSplitHex } from "./usageSplitPalette.ts";

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
});
