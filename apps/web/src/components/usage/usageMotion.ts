// One-shot motion for the Usage page's breakdown boxes and chart. All of it is Web Animations on
// elements React does not restyle, every animation ends by itself, and nothing runs at rest.

import {
  BRANCH_DOWN,
  cubicBezier,
  EASE_OPEN,
  EASE_OUT,
  EASE_TRAVEL,
  spring,
} from "../sidebar/crewMotion/crewMotion.logic";

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const supportsLinear = () =>
  typeof CSS !== "undefined" && CSS.supports("animation-timing-function", "linear(0, 1)");

/** A damped spring as a CSS `linear()` curve, sampled over its own length; a back-ease without. */
function springCurve(damping: number, samples = 60): string {
  if (!supportsLinear()) return "cubic-bezier(0.34, 1.56, 0.64, 1)";
  const w = 6.9 / damping;
  const wd = w * Math.sqrt(1 - damping * damping);
  const points = Array.from({ length: samples + 1 }, (_, k) => {
    const t = k / samples;
    return (
      1 -
      Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t))
    ).toFixed(4);
  });
  points[samples] = "1";
  return `linear(${points.join(", ")})`;
}

/** About a quarter overshoot: what the reward click and the rising bars land on. */
const BOUNCE = springCurve(0.42);

/** Where a chart switch starts: the side the breakdown boxes are on. */
export type ChartWaveOrigin = "start" | "end";

const order = (index: number, count: number, from: ChartWaveOrigin) =>
  from === "end" ? count - 1 - index : index;

/**
 * Drop and rise: each old bar falls into the baseline, then its new bar springs up past its
 * height and settles, one day after another from the boxes' side. Resolves when the last lands.
 */
export function dropAndRise(
  outgoing: readonly HTMLElement[],
  incoming: readonly HTMLElement[],
  from: ChartWaveOrigin,
): Promise<unknown> {
  const fall = 130;
  const stagger = 8;
  const pause = 20;
  const rise = 560;
  const count = Math.max(outgoing.length, incoming.length);
  outgoing.forEach((bar, index) => {
    bar.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }], {
      duration: fall,
      delay: order(index, count, from) * stagger,
      easing: "cubic-bezier(0.55, 0, 0.8, 0.3)",
      fill: "forwards",
    });
  });
  return Promise.all(
    incoming.map(
      (bar, index) =>
        bar.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], {
          duration: rise,
          delay: order(index, count, from) * stagger + fall + pause,
          easing: BOUNCE,
          fill: "backwards",
        }).finished,
    ),
  ).catch(() => undefined);
}

/** A parent opening or closing: each bar cross-fades into its new split, left to right. */
export function crossFade(
  outgoing: readonly HTMLElement[],
  incoming: readonly HTMLElement[],
): Promise<unknown> {
  outgoing.forEach((bar, index) => {
    bar.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 160,
      delay: index * 8 + 160,
      easing: "ease-in",
      fill: "forwards",
    });
  });
  return Promise.all(
    incoming.map(
      (bar, index) =>
        bar.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 320,
          delay: index * 8,
          easing: "ease-out",
          fill: "backwards",
        }).finished,
    ),
  ).catch(() => undefined);
}

/** Sparks in the bar's own colours burst from where it was clicked, inside `host`. */
export function burst(host: HTMLElement, x: number, y: number, colors: readonly string[]): void {
  if (colors.length === 0) return;
  for (let k = 0; k < 16; k++) {
    const spark = host.ownerDocument.createElement("i");
    Object.assign(spark.style, {
      position: "absolute",
      left: `${x - 3}px`,
      top: `${y - 3}px`,
      width: "6px",
      height: "6px",
      borderRadius: "2px",
      background: colors[k % colors.length]!,
      pointerEvents: "none",
      zIndex: "3",
    });
    host.append(spark);
    const angle = (k / 16) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 22 + Math.random() * 34;
    spark
      .animate(
        [
          { transform: "translate(0, 0) scale(1) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance - 8}px) scale(0.2) rotate(${180 + Math.random() * 180}deg)`,
            opacity: 0,
          },
        ],
        { duration: 520 + Math.random() * 220, easing: "cubic-bezier(0.15, 0.8, 0.3, 1)" },
      )
      .finished.then(
        () => spark.remove(),
        () => spark.remove(),
      );
  }
}

/** The card springs open from a little smaller, with a passing shadow. */
export function pop(card: HTMLElement): void {
  card.animate([{ transform: "scale(0.88) translateY(6px)" }, { transform: "none" }], {
    duration: 900,
    easing: BOUNCE,
  });
  card.animate(
    [
      { boxShadow: "0 0 0 0 transparent" },
      {
        boxShadow:
          "0 14px 36px -12px color-mix(in srgb, var(--foreground) 40%, transparent), 0 0 0 3px color-mix(in srgb, var(--primary) 30%, transparent)",
        offset: 0.3,
      },
      { boxShadow: "0 0 0 0 transparent" },
    ],
    { duration: 900, easing: cubicBezier(EASE_OUT) },
  );
}

/** How thick the bar is at a point `tau` ms into its ring, `reach` of the bar from the click. */
function rippleScale(tau: number, reach: number): number {
  if (tau <= 0 || tau >= 900) return 1;
  const amplitude = 1.5 * Math.exp(-1.6 * reach);
  return Math.max(0.55, 1 + amplitude * Math.exp(-tau / 230) * Math.sin((2 * Math.PI * tau) / 230));
}

/**
 * Ripple: the bar's thickness rings outwards from the click like a dropped stone. A point `d`px
 * from the click starts `d / 1.1` ms later. The bar is redrawn for the moment as one solid shape
 * per segment, laid out like the bar, clipped every frame to the wave's outline.
 */
export function ripple(bar: HTMLElement, clickAt: number): void {
  const segments = [...bar.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.segment !== undefined,
  );
  if (segments.length === 0 || bar.offsetWidth === 0) return;
  const doc = bar.ownerDocument;
  const layer = doc.createElement("span");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    display: "flex",
    pointerEvents: "none",
  });
  const shapes = segments.map((segment) => {
    const wrap = doc.createElement("span");
    Object.assign(wrap.style, { position: "relative", height: "100%", flex: segment.style.flex });
    const shape = doc.createElement("span");
    Object.assign(shape.style, {
      position: "absolute",
      left: "0",
      right: "0",
      top: "50%",
      height: "300%",
      translate: "0 -50%",
      background: getComputedStyle(segment).backgroundColor,
    });
    wrap.append(shape);
    layer.append(wrap);
    return { wrap, shape };
  });
  bar.append(layer);
  for (const segment of segments) segment.style.visibility = "hidden";
  const total = 900 + 40 + bar.offsetWidth / 1.1;
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    const width = bar.offsetWidth;
    const thickness = bar.offsetHeight;
    const clickPx = clickAt * width;
    const reads = shapes.map(({ wrap }) => ({ left: wrap.offsetLeft, width: wrap.offsetWidth }));
    shapes.forEach(({ shape }, index) => {
      const { left, width: own } = reads[index]!;
      const height = thickness * 3;
      const top: string[] = [];
      const bottom: string[] = [];
      const points = Math.max(2, Math.ceil(own / 2));
      for (let k = 0; k <= points; k++) {
        const local = (k / points) * own;
        const x = left + local;
        const distance = Math.abs(x - clickPx);
        let half = (thickness * rippleScale(t - 40 - distance / 1.1, distance / width)) / 2;
        // The bar's two outer ends stay round: a half-circle of the current thickness.
        if (index === 0 && x < half) half *= Math.sqrt(Math.max(0, 1 - ((half - x) / half) ** 2));
        const fromEnd = width - x;
        if (index === shapes.length - 1 && fromEnd < half) {
          half *= Math.sqrt(Math.max(0, 1 - ((half - fromEnd) / half) ** 2));
        }
        const px = `${own === 0 ? 0 : ((local / own) * 100).toFixed(2)}%`;
        top.push(`${px} ${(((height / 2 - half) / height) * 100).toFixed(2)}%`);
        bottom.unshift(`${px} ${(((height / 2 + half) / height) * 100).toFixed(2)}%`);
      }
      shape.style.clipPath = `polygon(${[...top, ...bottom].join(",")})`;
    });
    if (t < total && layer.isConnected) requestAnimationFrame(frame);
    else {
      layer.remove();
      for (const segment of segments) segment.style.visibility = "";
    }
  };
  requestAnimationFrame(frame);
}

// The left nav's Unfold, from crewMotion: the trunk grows, the branch draws down and round its
// corner, then the row fades and snaps. Played at 0.45 of the nav's pace; closing at 0.7 of that.
const PACE = 0.45;
const CLOSE = 0.7;
const SNAP = spring(520 / PACE ** 2, 30 / PACE);
const paced = (start: number, duration: number) => ({
  start: Math.round(start * PACE),
  duration: Math.round(duration * PACE),
});
const UNFOLD = {
  open: paced(0, 320),
  branch: paced(60, 460),
  fade: paced(300, 140),
  snap: { start: Math.round(300 * PACE), duration: SNAP.duration },
};
const UNFOLD_TOTAL = Math.max(...Object.values(UNFOLD).map((part) => part.start + part.duration));
const STAGGER_MS = Math.round(110 * PACE);
const BRANCH_STROKE: Keyframe[] = [
  { clipPath: "inset(0 calc(100% - 1px) 100% 0)", easing: cubicBezier(EASE_TRAVEL) },
  { clipPath: "inset(0 calc(100% - 8px) 0 0)", offset: BRANCH_DOWN, easing: cubicBezier(EASE_OUT) },
  { clipPath: "inset(0 0 0 0)" },
];
const TRUNK_GROW: Keyframe[] = [
  { transform: "scaleY(0)", transformOrigin: "top" },
  { transform: "scaleY(1)", transformOrigin: "top" },
];
const ROW_FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const ROW_SNAP: Keyframe[] = [
  { transform: "translateX(-10px) scale(0.965)", transformOrigin: "left center" },
  { transform: "none", transformOrigin: "left center" },
];

/** One child row as the tree animates it: its trunk, its elbow and its cells. */
export interface TreeRow {
  readonly trunk: HTMLElement | null;
  readonly elbow: HTMLElement | null;
  readonly cells: readonly HTMLElement[];
}

/** Children joining a parent, one after another down the tree. */
export function unfold(rows: readonly TreeRow[]): void {
  rows.forEach((row, index) => {
    const delay = index * STAGGER_MS;
    const play = (part: { start: number; duration: number }, easing: string) =>
      ({ duration: part.duration, delay: delay + part.start, easing, fill: "backwards" }) as const;
    row.trunk?.animate(TRUNK_GROW, play(UNFOLD.open, cubicBezier(EASE_OPEN)));
    row.elbow?.animate(BRANCH_STROKE, play(UNFOLD.branch, "linear"));
    for (const cell of row.cells) {
      cell.animate(ROW_FADE, play(UNFOLD.fade, "linear"));
      cell.animate(ROW_SNAP, play(UNFOLD.snap, SNAP.easing));
    }
  });
}

/** Children leaving: the same timeline mirrored, faster. Resolves when they have gone. */
export function fold(rows: readonly TreeRow[]): Promise<unknown> {
  const rewind = (part: { start: number; duration: number }, easing: string) =>
    ({
      duration: Math.round(part.duration * CLOSE),
      delay: Math.round((UNFOLD_TOTAL - part.start - part.duration) * CLOSE),
      easing,
      direction: "reverse",
      fill: "forwards",
    }) as const;
  const animations = rows.flatMap((row) => [
    ...(row.trunk === null
      ? []
      : [row.trunk.animate(TRUNK_GROW, rewind(UNFOLD.open, cubicBezier(EASE_OPEN)))]),
    ...(row.elbow === null
      ? []
      : [row.elbow.animate(BRANCH_STROKE, rewind(UNFOLD.branch, "linear"))]),
    ...row.cells.flatMap((cell) => [
      cell.animate(ROW_FADE, rewind(UNFOLD.fade, "linear")),
      cell.animate(ROW_SNAP, rewind(UNFOLD.snap, SNAP.easing)),
    ]),
  ]);
  return Promise.all(animations.map((animation) => animation.finished)).catch(() => undefined);
}

/** How long a fold runs before the rows below start gliding up into the space. */
export const SHUT_AFTER_MS = 70;
/** The nav's retract curve, for the rows below gliding into a closed parent's space. */
export const SHUT = { duration: 170, easing: "cubic-bezier(0.3, 0, 0.2, 1)" } as const;
/** The rows below a parent gliding down as its children unfold. */
export const OPEN_SPACE = {
  duration: UNFOLD.open.duration,
  easing: cubicBezier(EASE_OPEN),
} as const;

/** Rows glide from where they were (`deltas`, px) to where layout now puts them. */
export function glide(
  moves: readonly { readonly cells: readonly HTMLElement[]; readonly delta: number }[],
  timing: KeyframeAnimationOptions,
): void {
  for (const { cells, delta } of moves) {
    if (Math.abs(delta) < 0.5) continue;
    for (const cell of cells) {
      cell.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], timing);
    }
  }
}
