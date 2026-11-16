// The crew motion's numbers: which rows get an entrance, and the timeline both directions read.

/** A row counts as a worker that just started for this long after its thread was created. */
const FRESH_MS = 6000;
/** Several crewmates starting together enter one after another, this far apart. */
const STAGGER_MS = 110;

/** Decides which rows joining the crew line get an entrance, and when each may start. */
export function createCrewEntranceGate() {
  const seen = new Set<string>();
  let nextSlotAt = 0;
  return {
    /** True once per thread, and only while the thread is new: reloads and re-mounts stay still. */
    admits(threadKey: string, ageMs: number): boolean {
      if (seen.has(threadKey)) return false;
      seen.add(threadKey);
      return ageMs <= FRESH_MS;
    },
    /** How long an entrance asked for at `now` waits for its turn. */
    wait(now: number): number {
      const start = Math.max(now, nextSlotAt);
      nextSlotAt = start + STAGGER_MS;
      return start - now;
    },
  };
}

/** A cubic-bezier easing as its control values, so a curve can also be run backwards. */
export type Bezier = readonly [x1: number, y1: number, x2: number, y2: number];

export const cubicBezier = ([x1, y1, x2, y2]: Bezier) => `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;

const flipped = (value: number) => Math.round((1 - value) * 1e4) / 1e4;

/** The same curve played backwards in time. */
export const timeReversed = ([x1, y1, x2, y2]: Bezier): Bezier => [
  flipped(x2),
  flipped(y2),
  flipped(x1),
  flipped(y1),
];

/** A damped spring from 0 to 1 as a CSS `linear()` easing, with the time it takes to settle. */
function spring(stiffness: number, damping: number) {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  const wd = w0 * Math.sqrt(Math.max(1 - zeta * zeta, 1e-6));
  const at = (t: number) =>
    zeta < 1
      ? 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
      : 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  let settle = 0;
  for (let t = 0; t < 3; t += 1 / 240) if (Math.abs(1 - at(t)) > 0.002) settle = t;
  const points = Array.from({ length: 48 }, (_, i) => +at((settle * i) / 47).toFixed(4));
  points[47] = 1;
  return { easing: `linear(${points.join(", ")})`, duration: Math.round(settle * 1000) };
}

// Decelerating curves: things arrive fast and land softly.
export const EASE_OPEN: Bezier = [0.32, 0.72, 0, 1];
export const EASE_OUT: Bezier = [0.2, 0, 0, 1];
export const EASE_TRAVEL: Bezier = [0.55, 0, 0.25, 1];
/** About 6% overshoot, settling in roughly 0.43 s: a card that snaps and lands. */
export const SNAP = spring(520, 30);

/** One part of the entrance, such as the branch drawing. */
export interface Part {
  /** Milliseconds after the entrance starts. */
  start: number;
  duration: number;
}

/** The share of the branch's time spent on its downward stroke; the rest goes across to the card. */
export const BRANCH_DOWN = 0.55;

/**
 * Unfold's entrance: a space opens, the branch draws down into it, the card snaps in. The exit
 * plays the same parts backwards, so the two cannot drift apart.
 */
export const UNFOLD = {
  open: { start: 0, duration: 320 },
  branch: { start: 60, duration: 460 },
  fade: { start: 300, duration: 140 },
  snap: { start: 300, duration: SNAP.duration },
} satisfies Record<string, Part>;

/** The branch's downward stroke, which the Trace light rides. */
export const STROKE: Part = {
  start: UNFOLD.branch.start,
  duration: Math.round(UNFOLD.branch.duration * BRANCH_DOWN),
};

export const UNFOLD_TOTAL = Math.max(
  ...Object.values(UNFOLD).map((part) => part.start + part.duration),
);

/** When a part runs on the way in, for an entrance that waits `delay` for its turn. */
export const entering = (part: Part, delay: number) => ({
  duration: part.duration,
  delay: delay + part.start,
});

/** When the same part runs on the way out: the entrance's timeline, mirrored end for end. */
export const leaving = (part: Part) => ({
  duration: part.duration,
  delay: UNFOLD_TOTAL - part.start - part.duration,
});

/**
 * How long the Trace light takes from a leaving row up the line to FirstMate. The light leaves
 * its row `STROKE.start` before the space has shut, so it never takes less: a row carried up by
 * rows leaving above it has then landed by the time its light gets home.
 */
export const climbMs = (distancePx: number) =>
  Math.round(Math.min(240, Math.max(STROKE.start, 0.55 * distancePx)));
