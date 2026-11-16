import { describe, expect, it } from "vite-plus/test";

import {
  climbMs,
  createCrewEntranceGate,
  EASE_OPEN,
  leaving,
  SNAP,
  STROKE,
  timeReversed,
  UNFOLD,
  UNFOLD_TOTAL,
} from "./crewMotion.logic";

describe("crew entrance gate", () => {
  it("admits a thread once, and only while it is new", () => {
    const gate = createCrewEntranceGate();
    expect(gate.admits("new", 6000)).toBe(true);
    expect(gate.admits("new", 0)).toBe(false);
    // A row first seen when its thread is old stays still for good, such as after a reload.
    expect(gate.admits("old", 6001)).toBe(false);
    expect(gate.admits("old", 0)).toBe(false);
  });

  it("lets entrances asked for together in one after another, 110 ms apart", () => {
    const gate = createCrewEntranceGate();
    expect([gate.wait(1000), gate.wait(1000), gate.wait(1002)]).toEqual([0, 110, 218]);
    // The queue has emptied by now, so the next one starts at once.
    expect(gate.wait(1400)).toBe(0);
  });
});

describe("Unfold timeline", () => {
  it("leaves as the entrance played backwards", () => {
    expect(SNAP.duration).toBe(425);
    expect(UNFOLD_TOTAL).toBe(725);
    // The card un-snaps first and the space shuts last: each part's window, mirrored end for end.
    expect({
      snap: leaving(UNFOLD.snap),
      fade: leaving(UNFOLD.fade),
      branch: leaving(UNFOLD.branch),
      open: leaving(UNFOLD.open),
    }).toEqual({
      snap: { delay: 0, duration: 425 },
      fade: { delay: 285, duration: 140 },
      branch: { delay: 205, duration: 460 },
      open: { delay: 405, duration: 320 },
    });
    expect(timeReversed(EASE_OPEN)).toEqual([1, 0, 0.68, 0.28]);
  });

  it("snaps the card in with a small overshoot", () => {
    const points = SNAP.easing.slice("linear(".length, -1).split(", ").map(Number);
    expect(points.at(0)).toBe(0);
    expect(points.at(-1)).toBe(1);
    expect(Math.max(...points)).toBeCloseTo(1.064, 3);
  });

  it("gets the Trace light home no sooner than the space shuts", () => {
    const leavesRowAt = leaving(STROKE).delay + STROKE.duration;
    expect(leavesRowAt + climbMs(0)).toBe(UNFOLD_TOTAL);
    expect([climbMs(64), climbMs(271), climbMs(2000)]).toEqual([60, 149, 240]);
  });
});
