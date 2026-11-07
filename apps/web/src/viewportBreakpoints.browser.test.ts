import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

// lg: a desktop window narrower than this still crosses it once when it grows for the panel.
const LARGEST_BREAKPOINT_PX = 1024;

function viewportWidthBreakpoints(): Map<number, string> {
  const found = new Map<number, string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        for (const [, value, unit] of rule.conditionText.matchAll(
          /width\s*[<>]=?\s*([\d.]+)(px|rem)/g,
        )) {
          const px = Number(value) * (unit === "rem" ? 16 : 1);
          found.set(px, found.get(px) ?? rule.cssText.slice(0, 120));
        }
      }
      if ("cssRules" in rule) visit(rule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of document.styleSheets) visit(sheet.cssRules);
  return found;
}

describe("viewport breakpoints", () => {
  it("has none the desktop window crosses when it grows for the right panel", () => {
    // A flip of any media rule in the layered stylesheet restyles and relays out the whole
    // document in that frame, which in a long thread keeps the grown window blank.
    const tooWide = [...viewportWidthBreakpoints()].filter(([px]) => px > LARGEST_BREAKPOINT_PX);
    expect(tooWide).toEqual([]);
  });
});
