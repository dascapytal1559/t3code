// Unfold: a space opens under FirstMate, the branch draws down into it, and the card snaps in.
// Leaving is the same thing backwards.

import type { CrewEnterStage, CrewExitStage } from "./crewMotion";
import {
  BRANCH_DOWN,
  cubicBezier,
  EASE_OPEN,
  EASE_OUT,
  EASE_TRAVEL,
  entering,
  leaving,
  type Part,
  SNAP,
  timeReversed,
  UNFOLD,
  UNFOLD_TOTAL,
} from "./crewMotion.logic";

const CARD_FADE = [{ opacity: 0 }, { opacity: 1 }];
const CARD_SNAP = [
  { transform: "translateX(-10px) scale(0.965)", transformOrigin: "left center" },
  { transform: "none", transformOrigin: "left center" },
];
// The elbow drawn as one stroke: down the vertical, round the corner, across.
const BRANCH_STROKE = [
  { clipPath: "inset(0 calc(100% - 1px) 100% 0)", easing: cubicBezier(EASE_TRAVEL) },
  { clipPath: "inset(0 calc(100% - 8px) 0 0)", offset: BRANCH_DOWN, easing: cubicBezier(EASE_OUT) },
  { clipPath: "inset(0 0 0 0)" },
];
const TRUNK_GROW = [
  { transform: "scaleY(0)", transformOrigin: "top" },
  { transform: "scaleY(1)", transformOrigin: "top" },
];

/** Holds the rows `from` pixels off their place, then lets them slide home. */
function slide(rows: HTMLElement[], from: number, timing: KeyframeAnimationOptions) {
  for (const row of rows) {
    row.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], {
      ...timing,
      fill: "backwards",
      // Adds to any move already running, so a second card mid-motion composes with the first.
      composite: "add",
    });
  }
}

export function enter({ card, elbow, trunk, below, shift, delay }: CrewEnterStage) {
  const play = (part: Part, easing: string) =>
    ({ ...entering(part, delay), easing, fill: "backwards" }) as const;
  const open = play(UNFOLD.open, cubicBezier(EASE_OPEN));
  slide(below, -shift, open);
  trunk?.animate(TRUNK_GROW, open);
  elbow?.animate(BRANCH_STROKE, play(UNFOLD.branch, "linear"));
  card.animate(CARD_FADE, play(UNFOLD.fade, "linear"));
  card.animate(CARD_SNAP, play(UNFOLD.snap, SNAP.easing));
}

/** Returns the animations the leaving row's copy has to outlive. */
export function exit({ row, card, elbow, trunk, below, shift, bridge }: CrewExitStage) {
  // Each part runs in reverse on its own curve, so the card un-snaps, the branch un-draws and
  // the space shuts in the opposite order to how they came.
  const rewind = (part: Part, easing: string) =>
    ({ ...leaving(part), easing, direction: "reverse", fill: "forwards" }) as const;
  const snap = card.animate(CARD_SNAP, rewind(UNFOLD.snap, SNAP.easing));
  const fade = card.animate(CARD_FADE, rewind(UNFOLD.fade, "linear"));
  const stroke = elbow?.animate(BRANCH_STROKE, rewind(UNFOLD.branch, "linear"));
  // The rows end at rest whichever way the space moves, so their curve is reversed instead.
  slide(below, shift, {
    ...leaving(UNFOLD.open),
    easing: cubicBezier(timeReversed(EASE_OPEN)),
  });
  trunk?.animate(TRUNK_GROW, rewind(UNFOLD.open, cubicBezier(EASE_OPEN)));
  // Animates nothing: it keeps the copy on the page until the space has shut.
  const shut = row.animate([{ opacity: 1 }, { opacity: 1 }], { duration: UNFOLD_TOTAL });
  // Once this row's line has gone (its branch, and its trunk if a leaving row hung below it),
  // the line carries on up to the row above.
  const retract = bridge?.retract({
    duration: 160,
    delay: trunk === null ? leaving(UNFOLD.branch).delay + UNFOLD.branch.duration : UNFOLD_TOTAL,
    easing: "cubic-bezier(0.3, 0, 0.2, 1)",
  });
  return [snap, fade, stroke, shut, retract];
}
