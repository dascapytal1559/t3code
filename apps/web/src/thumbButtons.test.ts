import { describe, expect, it } from "vite-plus/test";

import { installThumbButtonGuard } from "./thumbButtons";

function press(target: EventTarget, type: string, button: number) {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { button });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("installThumbButtonGuard", () => {
  it("cancels Chromium's focus and history defaults for thumb buttons only", () => {
    const target = new EventTarget();
    installThumbButtonGuard(target);

    for (const type of ["mousedown", "mouseup"]) {
      expect(press(target, type, 3)).toBe(true);
      expect(press(target, type, 4)).toBe(true);
      expect(press(target, type, 0)).toBe(false);
      expect(press(target, type, 1)).toBe(false);
      expect(press(target, type, 2)).toBe(false);
    }
  });
});
