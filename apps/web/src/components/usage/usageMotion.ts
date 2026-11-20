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

/** Where a chart switch starts: the side the breakdown boxes are on. */
export type ChartWaveOrigin = "start" | "end";

/** How far behind the first bar the last one starts, however many days the chart shows. */
const WAVE_SPREAD_MS = 60;

/** A bar's delay in a wave that crosses the chart in `WAVE_SPREAD_MS`. */
const waveDelay = (index: number, count: number, from: ChartWaveOrigin) =>
  count <= 1 ? 0 : ((from === "end" ? count - 1 - index : index) / (count - 1)) * WAVE_SPREAD_MS;

/** A chart bar falling into the baseline at a card switch. */
const BAR_FALL = { duration: 90, easing: "cubic-bezier(0.55, 0, 0.8, 0.3)" };
/** A chart bar rising in its place once the old one has fallen. */
const BAR_RISE = { duration: 150, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

/**
 * Drop and rise: each old bar falls into the baseline and its new bar rises in its place, in a
 * quick wave from the boxes' side. 300 ms at most; resolves when the last lands.
 */
export function dropAndRise(
  outgoing: readonly HTMLElement[],
  incoming: readonly HTMLElement[],
  from: ChartWaveOrigin,
): Promise<unknown> {
  const count = Math.max(outgoing.length, incoming.length);
  outgoing.forEach((bar, index) => {
    bar.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }], {
      ...BAR_FALL,
      delay: waveDelay(index, count, from),
      fill: "forwards",
    });
  });
  return Promise.all(
    incoming.map(
      (bar, index) =>
        bar.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], {
          ...BAR_RISE,
          delay: waveDelay(index, count, from) + BAR_FALL.duration,
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
  const count = Math.max(outgoing.length, incoming.length);
  outgoing.forEach((bar, index) => {
    bar.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 160,
      delay: waveDelay(index, count, "start") + 160,
      easing: "ease-in",
      fill: "forwards",
    });
  });
  return Promise.all(
    incoming.map(
      (bar, index) =>
        bar.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 320,
          delay: waveDelay(index, count, "start"),
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

/** A card opening out of its bar, which holds still while the card grows around it. */
const CARD_REVEAL = { duration: 420, easing: cubicBezier(EASE_OPEN) };
/** The column closing up, from `delay` ms into the opening, when the opening moved the bar. */
const CARD_SETTLE = { delay: 150, duration: 260, easing: "cubic-bezier(0.3, 0, 0.2, 1)" };

/**
 * The card grows out of its bar's outline, and the bar eases from where the folded bar stood
 * (`from`, viewport px) into its place in the card.
 */
export function reveal(
  card: HTMLElement,
  bar: HTMLElement,
  from: { readonly left: number; readonly width: number },
): void {
  const c = card.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const left = Math.max(0, from.left - c.left);
  const right = Math.max(0, c.right - from.left - from.width);
  card.animate(
    [
      {
        clipPath: `inset(${b.top - c.top}px ${right}px ${c.bottom - b.bottom}px ${left}px round 2px)`,
      },
      { clipPath: `inset(0 round ${getComputedStyle(card).borderTopLeftRadius})` },
    ],
    CARD_REVEAL,
  );
  regrow(bar, from);
}

/**
 * A share bar easing from where it stood into its place, with the card opening: `from` is its
 * old left and width in viewport px, `dy` how far it stood below its place in its own box.
 */
export function regrow(
  bar: HTMLElement,
  from: { readonly left: number; readonly width: number },
  dy = 0,
): void {
  const b = bar.getBoundingClientRect();
  if (b.width === 0) return;
  bar.animate(
    [
      {
        transform: `translate(${from.left - b.left}px, ${dy}px) scaleX(${from.width / b.width})`,
        transformOrigin: "left",
      },
      { transform: "none", transformOrigin: "left" },
    ],
    CARD_REVEAL,
  );
}

/**
 * A breakdown in the column while a card opens: from `start` px off its place it moves to `held`
 * px with the opening, and from `CARD_SETTLE.delay` settles into place. The two moves add, so the
 * settle can start before the opening has finished.
 */
export function keepStation(element: HTMLElement, start: number, held: number): void {
  if (Math.abs(start - held) >= 0.5) {
    element.animate(
      [{ transform: `translateY(${start - held}px)` }, { transform: "none" }],
      CARD_REVEAL,
    );
  }
  if (Math.abs(held) >= 0.5) {
    element.animate([{ transform: `translateY(${held}px)` }, { transform: "none" }], {
      ...CARD_SETTLE,
      fill: "backwards",
      composite: "add",
    });
  }
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
  // The bar clips its segments to its rounded ends; the wave reaches past them and draws its own.
  const corner = Number.parseFloat(getComputedStyle(bar).borderStartStartRadius) || 0;
  bar.append(layer);
  bar.style.overflow = "visible";
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
        // The bar's two outer ends keep its corner radius at the current thickness.
        const fromEdge = Math.min(
          index === 0 ? x : Infinity,
          index === shapes.length - 1 ? width - x : Infinity,
        );
        const radius = Math.min(corner, half);
        if (fromEdge < radius) {
          half -= radius - Math.sqrt(Math.max(0, radius ** 2 - (radius - fromEdge) ** 2));
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
      bar.style.overflow = "";
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
