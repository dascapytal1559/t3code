// The Trace add-on: an accent light on top of Unfold. It rides the tip of the branch as Unfold
// draws it, leaving the branch and the card warm behind it, and when a row leaves it rides the
// branch back up and carries on home to FirstMate. It adds to Unfold's timeline and changes none
// of it.

import type { CrewEnterStage, CrewExitStage } from "./crewMotion";
import {
  climbMs,
  cubicBezier,
  EASE_TRAVEL,
  entering,
  leaving,
  STROKE,
  timeReversed,
  UNFOLD,
} from "./crewMotion.logic";

const ACCENT = "var(--primary)";
const ACCENT_WASH = "color-mix(in srgb, var(--primary) 16%, transparent)";
// The branch stays lit for this share of its glow, then cools to the line's own colour.
const BRANCH_GLOW = { hold: 0.55, coolMs: 540 };
const CARD_WASH = { hold: 0.3, durationMs: 1200 };

// Along the stroke, 0% is the top of the row's line and 100% the card.
const RIDE_DOWN = [
  { offsetDistance: "0%", opacity: 0, offset: 0 },
  { offsetDistance: "5%", opacity: 1, offset: 0.05 },
  { offsetDistance: "95%", opacity: 1, offset: 0.95 },
  { offsetDistance: "100%", opacity: 0, offset: 1 },
];
const RIDE_UP = [
  { offsetDistance: "100%", opacity: 0, offset: 0 },
  { offsetDistance: "95%", opacity: 1, offset: 0.05 },
  { offsetDistance: "0%", opacity: 1, offset: 1 },
];

/** A light inside `row`, set on the stroke its branch draws: down the line, round the corner, to the card. */
function lightOn(row: HTMLElement, card: HTMLElement, elbow: HTMLElement) {
  const origin = row.getBoundingClientRect();
  const line = elbow.getBoundingClientRect();
  // The line and its turn are the elbow's 1px borders; the light runs down their middle.
  const x = line.left - origin.left + 0.5;
  const y = line.bottom - origin.top - 0.5;
  const r = Number.parseFloat(getComputedStyle(elbow).borderBottomLeftRadius) || 0;
  const end = card.getBoundingClientRect().left - origin.left;
  const light = row.ownerDocument.createElement("span");
  Object.assign(light.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: "5px",
    height: "5px",
    borderRadius: "9999px",
    background: ACCENT,
    boxShadow: `0 0 8px 2px color-mix(in srgb, ${ACCENT} 55%, transparent)`,
    // Only its animations show it, so a copy of a row caught mid-entrance carries no stray light.
    opacity: "0",
    offsetPath: `path("M ${x} 0 L ${x} ${y - r} Q ${x} ${y} ${x + r} ${y} L ${end} ${y}")`,
    offsetRotate: "0deg",
    pointerEvents: "none",
    zIndex: "30",
  });
  row.append(light);
  return light;
}

export function enter({ row, card, elbow, delay }: CrewEnterStage) {
  if (elbow === null) return;
  const light = lightOn(row, card, elbow);
  const stroke = entering(STROKE, delay);
  // The same curve over the same time as the stroke, so the light sits on its tip.
  const ride = light.animate(RIDE_DOWN, {
    ...stroke,
    easing: cubicBezier(EASE_TRAVEL),
    fill: "both",
  });
  ride.onfinish = ride.oncancel = () => light.remove();
  elbow.animate(
    [{ borderColor: ACCENT, offset: 0 }, { borderColor: ACCENT, offset: BRANCH_GLOW.hold }, {}],
    {
      duration: stroke.duration + BRANCH_GLOW.coolMs,
      delay: stroke.delay,
      easing: "ease-out",
      fill: "backwards",
    },
  );
  card.animate(
    [
      { backgroundColor: ACCENT_WASH, offset: 0 },
      { backgroundColor: ACCENT_WASH, offset: CARD_WASH.hold },
      {},
    ],
    { ...entering(UNFOLD.snap, delay), duration: CARD_WASH.durationMs, easing: "linear" },
  );
}

/** Resolves once the light is home; the leaving row's copy has to stay until then. */
export function exit({ row, card, elbow, distanceHome }: CrewExitStage): Promise<unknown> {
  if (elbow === null) return Promise.resolve();
  const light = lightOn(row, card, elbow);
  const stroke = leaving(STROKE);
  elbow.animate([{ borderColor: ACCENT }, { borderColor: ACCENT }], {
    ...stroke,
    fill: "forwards",
  });
  return light
    .animate(RIDE_UP, {
      ...stroke,
      easing: cubicBezier(timeReversed(EASE_TRAVEL)),
      fill: "both",
    })
    .finished.then(() => {
      // Measured as the light leaves the row: rows above may have folded away since the exit began.
      const up = Math.max(0, distanceHome());
      return light.animate(
        [
          { translate: "0 0", opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.7 },
          { translate: `0 ${-up}px`, opacity: 0, offset: 1 },
        ],
        { duration: climbMs(up), easing: cubicBezier(EASE_TRAVEL), fill: "forwards" },
      ).finished;
    });
}
