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
  /** The row under the chart it sits in, from 0. */
  readonly row: number;
  /** Its date's centre on the axis. */
  readonly x: number;
}

const CHIP_GAP = 6;

/**
 * Lays chips out under the chart: each centred under its date where that fits in the plot, in the
 * first row where it clears the chips already there.
 */
export function layoutAnnotationChips({
  chips,
  periodCount,
  plotWidth,
}: {
  readonly chips: readonly AnnotationChipLayoutInput[];
  readonly periodCount: number;
  readonly plotWidth: number;
}): readonly AnnotationChipLayout[] {
  const step = plotWidth / Math.max(1, periodCount);
  const rows: { left: number; right: number }[][] = [];
  return chips.map(({ index, width }) => {
    const x = (index + 0.5) * step;
    const left = Math.min(Math.max(0, x - width / 2), Math.max(0, plotWidth - width));
    const clear = (row: readonly { left: number; right: number }[]) =>
      row.every((other) => left >= other.right + CHIP_GAP || left + width + CHIP_GAP <= other.left);
    let row = rows.findIndex(clear);
    if (row === -1) row = rows.push([]) - 1;
    rows[row]!.push({ left, right: left + width });
    return { left, row, x };
  });
}
