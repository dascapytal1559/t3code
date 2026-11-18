import type { UsageAnnotation } from "@t3tools/contracts";

const HOUR_MS = 60 * 60 * 1000;

export interface PlacedUsageAnnotation {
  readonly annotation: UsageAnnotation;
  /** The chart period the annotation's day starts in. */
  readonly index: number;
}

/** Each selected server's annotations, once each, oldest first. */
export function collectUsageAnnotations(
  lists: readonly (readonly UsageAnnotation[] | undefined)[],
): readonly UsageAnnotation[] {
  const byKey = new Map<string, UsageAnnotation>();
  for (const annotation of lists.flatMap((list) => list ?? [])) {
    byKey.set(JSON.stringify([annotation.date, annotation.label, annotation.logo]), annotation);
  }
  return [...byKey.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

/** Only annotations whose day starts inside the shown periods; in hours, the hour holding its midnight. */
export function placeUsageAnnotations(
  annotations: readonly UsageAnnotation[],
  periods: readonly string[],
  resolution: "day" | "hour",
  timeZone: string,
): readonly PlacedUsageAnnotation[] {
  if (resolution === "day") {
    return annotations.flatMap((annotation) => {
      const index = periods.indexOf(annotation.date);
      return index === -1 ? [] : [{ annotation, index }];
    });
  }
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayAt = (ms: number) => dayFormat.format(new Date(ms));
  return annotations.flatMap((annotation) => {
    const index = periods.findIndex((period) => {
      const start = Date.parse(period);
      return dayAt(start - 1) !== annotation.date && dayAt(start + HOUR_MS - 1) === annotation.date;
    });
    return index === -1 ? [] : [{ annotation, index }];
  });
}

export interface AnnotationChipLayoutInput {
  readonly index: number;
  readonly width: number;
}

export interface AnnotationChipLayout {
  readonly left: number;
  readonly top: number;
  /** Where the chip's line meets the axis. */
  readonly x: number;
}

const CHIP_GAP = 6;
/** Chips over short bars still sit in the plot's upper part, as the line reads better long. */
const LOWEST_CHIP_TOP = 0.3;
/** How far a chip set beside its line still overlaps it, so the line visibly meets the chip. */
const LINE_INSET = 10;

/**
 * Puts each chip just above the tallest bar under it and clear of earlier chips: centred on its
 * period when that fits, else beside its line on either side. Only a plot with no room anywhere
 * lets a chip cover a bar.
 */
export function layoutAnnotationChips({
  chips,
  periodCount,
  plotWidth,
  plotHeight,
  chipHeight,
  barTop,
}: {
  readonly chips: readonly AnnotationChipLayoutInput[];
  readonly periodCount: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly chipHeight: number;
  /** Pixels from the plot's top to the top of the bar at a period. */
  readonly barTop: (index: number) => number;
}): readonly AnnotationChipLayout[] {
  const step = plotWidth / Math.max(1, periodCount);
  const placed: (AnnotationChipLayout & { readonly width: number })[] = [];
  const topAt = (left: number, width: number) => {
    const first = Math.max(0, Math.floor(left / step));
    const last = Math.min(periodCount - 1, Math.floor((left + width) / step));
    let tallest = plotHeight;
    for (let period = first; period <= last; period += 1) {
      tallest = Math.min(tallest, barTop(period));
    }
    let top = Math.min(tallest - CHIP_GAP - chipHeight, plotHeight * LOWEST_CHIP_TOP);
    const overlapping = placed.filter(
      (other) => other.left < left + width + CHIP_GAP && left < other.left + other.width + CHIP_GAP,
    );
    for (const other of overlapping.toSorted((a, b) => b.top - a.top)) {
      if (top + chipHeight + CHIP_GAP > other.top && top < other.top + chipHeight + CHIP_GAP) {
        top = other.top - CHIP_GAP - chipHeight;
      }
    }
    return { top, overlapping };
  };
  for (const { index, width } of chips) {
    const x = (index + 0.5) * step;
    const clamp = (left: number) => Math.min(Math.max(0, left), Math.max(0, plotWidth - width));
    const candidates = [x - width / 2, x - width + LINE_INSET, x - LINE_INSET].map(clamp);
    const fitting = candidates
      .map((left) => ({ left, ...topAt(left, width) }))
      .find((candidate) => candidate.top >= 0);
    if (fitting !== undefined) {
      placed.push({ left: fitting.left, top: fitting.top, x, width });
      continue;
    }
    const left = candidates[0] ?? 0;
    const { overlapping } = topAt(left, width);
    const lowest = Math.max(...overlapping.map((other) => other.top), -Infinity);
    const top = lowest === -Infinity ? 0 : lowest + chipHeight + CHIP_GAP;
    placed.push({ left, top, x, width });
  }
  return placed.map(({ left, top, x }) => ({ left, top, x }));
}
