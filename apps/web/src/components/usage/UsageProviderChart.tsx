import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { UsageAnnotation, UsageProviderKind } from "@t3tools/contracts";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { formatRelativeHourShort } from "@t3tools/shared/usageFormatCopy";
import { cn } from "~/lib/utils";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { observeResize } from "~/lib/observeResize";
import { T3Wordmark } from "../T3Wordmark";
import { layoutAnnotationChips, type PlacedUsageAnnotation } from "./usageAnnotations";
import { crossFade, morphBars, pourOver, reducedMotion } from "./usageMotion";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const MAX_BAR_WIDTH = 64;
const MAX_AXIS_LABELS = 5;
const NO_ANNOTATIONS: readonly PlacedUsageAnnotation[] = [];

interface UsageChartWindowProps {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly hour12: boolean;
  readonly annotations?: readonly PlacedUsageAnnotation[];
}

export type UsageChartMetric = "tokens" | "cost";

/** One band of the stacked bars: a provider, a device or a kind of work. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** Drawn before the label in the hover split; a colour dot when absent. */
  readonly icon?: ReactNode;
  /** Its figures are still arriving, so it draws faded. */
  readonly loading?: boolean;
  /** Drawn below the centre line: the chart mirrors when any band is. */
  readonly below?: boolean;
}

export interface DayColumn {
  readonly bands: readonly { readonly key: string; readonly value: number }[];
  readonly total: number;
}

export function buildPeriodColumns(
  periods: readonly string[],
  series: readonly ChartSeries[],
  valueAt: (period: string, key: string) => number,
): readonly DayColumn[] {
  return periods.map((period) => {
    const bands = series.map(({ key }) => ({ key, value: valueAt(period, key) }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const PLACEHOLDER_TICKS = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index);

export function stackedPeak(columns: readonly DayColumn[]) {
  return columns.reduce((max, column) => Math.max(max, column.total), 0);
}

/** A column's bands above and below the centre line of a mirror chart. */
function sideTotals(column: DayColumn, series: readonly ChartSeries[]) {
  let up = 0;
  let down = 0;
  column.bands.forEach((band, slot) => {
    if (series[slot]?.below === true) down += band.value;
    else up += band.value;
  });
  return { up, down };
}

export function chartScale(columns: readonly DayColumn[], series: readonly ChartSeries[]) {
  const mirrored = series.some((entry) => entry.below === true);
  // A mirror chart scales both halves alike, to the larger side's peak, with half the ticks each.
  const peak = mirrored
    ? columns.reduce((max, column) => {
        const { up, down } = sideTotals(column, series);
        return Math.max(max, up, down);
      }, 0)
    : stackedPeak(columns);
  const count = mirrored ? TICK_COUNT / 2 : TICK_COUNT;
  return peak === 0 && series.some((entry) => entry.loading === true)
    ? { max: count, ticks: PLACEHOLDER_TICKS.slice(0, count + 1), labeled: false, mirrored }
    : { ...niceScale(peak, count), labeled: true, mirrored };
}

const MIRROR_HALF = (VIEW_HEIGHT - PLOT_TOP) / 2;
const MIRROR_MIDDLE = PLOT_TOP + MIRROR_HALF;

/** A value's height in the plot; in a mirror chart, above or below the centre line. */
function valueToY(value: number, max: number, mirror?: "up" | "down") {
  if (mirror !== undefined) {
    const offset = max === 0 ? 0 : (value / max) * MIRROR_HALF;
    return mirror === "up" ? MIRROR_MIDDLE - offset : MIRROR_MIDDLE + offset;
  }
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

// Sub-pixel gaps between a year of daily bars only add antialiasing seams.
export function barGeometry(count: number) {
  const step = VIEW_WIDTH / Math.max(1, count);
  const gap = step < 4 ? 0 : Math.max(1, step * 0.2);
  const width = Math.min(step - gap, MAX_BAR_WIDTH);
  return { step, width, inset: (step - width) / 2 };
}

/** Evenly spaced buckets to label, counted back from the latest so it is always labelled. */
export function axisLabelIndices(count: number): readonly number[] {
  if (count === 0) return [];
  const stride = Math.max(1, Math.ceil((count - 1) / (MAX_AXIS_LABELS - 1)));
  const indices: number[] = [];
  for (let index = count - 1; index >= 0; index -= stride) indices.unshift(index);
  return indices;
}

/**
 * The series' slots in stacking order, top band first: the largest over the window on top,
 * whatever order the legend lists them in. One order for every bar, so a band never hops.
 */
export function stackOrder(columns: readonly DayColumn[], count: number): readonly number[] {
  const totals = Array.from({ length: count }, (_, slot) =>
    columns.reduce((sum, column) => sum + (column.bands[slot]?.value ?? 0), 0),
  );
  return totals.map((_, slot) => slot).sort((a, b) => totals[b]! - totals[a]! || a - b);
}

/** A bar as the page draws it: its extent in the plot and its bands, top band first. */
interface ChartBar {
  readonly top: number;
  /** Where it ends, up from the plot's foot: 0 unless it hangs below a mirror chart's centre. */
  readonly bottom: number;
  readonly background: string;
  /** In a mirror chart, the centre line's place down the bar, in percent. */
  readonly centre?: number;
}

/** One element per bar, painted with hard colour stops, so its bands meet with no seam. */
function buildBars(
  columns: readonly DayColumn[],
  series: readonly ChartSeries[],
  max: number,
): readonly ChartBar[] {
  const order = stackOrder(columns, series.length);
  if (series.some((entry) => entry.below === true))
    return buildMirrorBars(columns, series, max, order);
  return columns.map((column) => {
    // Paint runs bottom up, so from the end of the stacking order.
    const stops: string[] = [];
    let at = 0;
    for (const slot of order.toReversed()) {
      const value = column.bands[slot]?.value ?? 0;
      if (value <= 0 || column.total <= 0) continue;
      const from = (at / column.total) * 100;
      at += value;
      stops.push(
        `${series[slot]!.color} ${from.toFixed(3)}% ${((at / column.total) * 100).toFixed(3)}%`,
      );
    }
    return {
      top: valueToY(column.total, max),
      bottom: 0,
      background:
        stops.length === 0 ? "transparent" : `linear-gradient(to top, ${stops.join(", ")})`,
    };
  });
}

/**
 * Mirror bars: the upper bands rise from the centre line and the lower bands hang from it, each
 * side with its largest band outermost. One element per period, painted top to bottom.
 */
function buildMirrorBars(
  columns: readonly DayColumn[],
  series: readonly ChartSeries[],
  max: number,
  order: readonly number[],
): readonly ChartBar[] {
  const upper = order.filter((slot) => series[slot]?.below !== true);
  const lower = order.filter((slot) => series[slot]?.below === true).toReversed();
  return columns.map((column) => {
    const { up, down } = sideTotals(column, series);
    const top = valueToY(up, max, "up");
    const foot = valueToY(down, max, "down");
    const height = foot - top;
    if (height <= 0) return { top, bottom: VIEW_HEIGHT - foot, background: "transparent" };
    const stops: string[] = [];
    let at = top;
    for (const slot of [...upper, ...lower]) {
      const value = column.bands[slot]?.value ?? 0;
      if (value <= 0) continue;
      const from = ((at - top) / height) * 100;
      at += (value / max) * MIRROR_HALF;
      stops.push(
        `${series[slot]!.color} ${from.toFixed(3)}% ${(((at - top) / height) * 100).toFixed(3)}%`,
      );
    }
    return {
      top,
      bottom: VIEW_HEIGHT - foot,
      background: `linear-gradient(to bottom, ${stops.join(", ")})`,
      centre: ((MIRROR_MIDDLE - top) / height) * 100,
    };
  });
}

function UsageChartTooltip({
  tooltipRef,
  label,
  column,
  series,
  format,
}: {
  readonly tooltipRef: React.Ref<HTMLDivElement>;
  readonly label: string;
  readonly column: DayColumn | undefined;
  readonly series: readonly ChartSeries[];
  readonly format: (value: number) => string;
}) {
  const partial = series.some((entry) => entry.loading === true);
  return (
    <div
      ref={tooltipRef}
      className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
      style={{
        left: "var(--usage-tooltip-left, 0px)",
        top: "var(--usage-tooltip-top, 0px)",
      }}
    >
      <div className="mb-1 text-muted-foreground">{label}</div>
      {series.map((entry, slot) => (
        <div key={entry.key} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {entry.icon ?? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
            )}
            {entry.label}
          </span>
          <span
            className={cn(
              "tabular-nums",
              entry.loading === true ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {format(column?.bands[slot]?.value ?? 0)}
          </span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
        <span className="text-muted-foreground">
          <T>Total</T>
        </span>
        <span className={cn("tabular-nums", partial ? "text-muted-foreground" : "text-foreground")}>
          {format(column?.total ?? 0)}
        </span>
      </div>
    </div>
  );
}

function UsageChartPlot({
  periods,
  columns,
  series,
  format,
  formatTooltipPeriod,
  children,
}: {
  readonly periods: readonly string[];
  readonly columns: readonly DayColumn[];
  readonly series: readonly ChartSeries[];
  readonly format: (value: number) => string;
  readonly formatTooltipPeriod: (period: string) => string;
  readonly children: React.ReactNode;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const positionTooltip = () => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the hover tooltip through plot CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;

    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    const index = Math.floor((localX / bounds.width) * periods.length);
    hoverPositionRef.current = { x: localX, y: localY };
    positionTooltip();
    setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
  };

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];

  return (
    <div
      ref={plotRef}
      className="relative h-full"
      onMouseMove={handleMove}
      onMouseLeave={() => {
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
    >
      <div aria-hidden className="absolute inset-0">
        {hoverIndex === null ? null : (
          <div
            className="absolute inset-y-0 bg-foreground/8"
            style={{
              left: `${(hoverIndex / periods.length) * 100}%`,
              width: `${100 / periods.length}%`,
            }}
          />
        )}
        {children}
      </div>

      {hoverIndex === null || hoveredPeriod === undefined ? null : (
        <UsageChartTooltip
          tooltipRef={tooltipRef}
          label={formatTooltipPeriod(hoveredPeriod)}
          column={columns[hoverIndex]}
          series={series}
          format={format}
        />
      )}
    </div>
  );
}

function T3Badge() {
  return (
    <span
      aria-label="T3"
      className="inline-flex h-4 items-center rounded-sm bg-info px-0.75 ring-1 ring-white/25"
    >
      <T3Wordmark aria-hidden className="h-2 w-auto text-white" />
    </span>
  );
}

function annotationKey({ date, label, logo }: UsageAnnotation): string {
  return `${date}:${label}:${logo ?? ""}`;
}

const CHIP_ROW_GAP = 4;

/**
 * The chart's annotations, under its axis: each chip hangs on a short line under its date, in as
 * many rows as overlapping chips need. The strip sizes itself to its rows.
 */
function UsageChartAnnotations({
  placed,
  periodCount,
  plotRef,
  zeroY,
}: {
  readonly placed: readonly PlacedUsageAnnotation[];
  readonly periodCount: number;
  /** The plot above, whose zero line each chip's line runs up to. */
  readonly plotRef: React.RefObject<HTMLDivElement | null>;
  /** The zero line in chart units: the foot, or a mirror chart's centre. */
  readonly zeroY: number;
}) {
  const locale = useLocale();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places chips from measured chip and strip sizes through CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (layer === null) return;
    const position = () => {
      const chipHeight = chipRefs.current[0]?.offsetHeight ?? 0;
      const layout = layoutAnnotationChips({
        chips: placed.map(({ index }, slot) => ({
          index,
          width: chipRefs.current[slot]?.offsetWidth ?? 0,
        })),
        periodCount,
        plotWidth: layer.clientWidth,
      });
      const lineLength = 6;
      const rowTop = (row: number) => lineLength + row * (chipHeight + CHIP_ROW_GAP);
      const plot = plotRef.current?.getBoundingClientRect();
      // How far above the strip the zero line sits; the lines run up to it over the axis.
      const zero =
        plot === undefined
          ? 0
          : plot.top + (zeroY / VIEW_HEIGHT) * plot.height - layer.getBoundingClientRect().top;
      layer.style.setProperty("--annotation-zero", `${zero}px`);
      layout.forEach(({ left, row, x }, slot) => {
        layer.style.setProperty(`--annotation-${slot}-left`, `${left}px`);
        layer.style.setProperty(`--annotation-${slot}-top`, `${rowTop(row)}px`);
        layer.style.setProperty(`--annotation-${slot}-x`, `${x}px`);
      });
      const rows = Math.max(0, ...layout.map(({ row }) => row + 1));
      layer.style.height = `${rows === 0 ? 0 : rowTop(rows) - CHIP_ROW_GAP}px`;
    };
    position();
    return observeResize([layer], position);
  }, [placed, periodCount, plotRef, zeroY]);

  return (
    <div ref={layerRef} className="pointer-events-none relative">
      {/* Lines first, so a later row's line never crosses an earlier row's chip. */}
      {placed.map(({ annotation }, slot) => (
        <div key={`line:${annotationKey(annotation)}`} aria-hidden>
          <div
            className="absolute w-px -translate-x-1/2 bg-foreground"
            style={{
              left: `var(--annotation-${slot}-x)`,
              top: "var(--annotation-zero)",
              height: `calc(var(--annotation-${slot}-top) - var(--annotation-zero))`,
            }}
          />
          <div
            className="absolute size-1.5 -translate-1/2 rounded-full bg-foreground"
            style={{ left: `var(--annotation-${slot}-x)`, top: "var(--annotation-zero)" }}
          />
        </div>
      ))}
      {placed.map(({ annotation }, slot) => (
        <div
          key={annotationKey(annotation)}
          ref={(element) => {
            chipRefs.current[slot] = element;
          }}
          className="absolute flex h-6 items-center gap-1 rounded-md bg-foreground px-2 text-xs font-semibold whitespace-nowrap text-background shadow-sm"
          style={{
            left: `var(--annotation-${slot}-left)`,
            top: `var(--annotation-${slot}-top)`,
          }}
        >
          <span className="sr-only">{formatDayShort(annotation.date, locale)}: </span>
          {annotation.label}
          {annotation.logo === "t3" ? <T3Badge /> : null}
        </div>
      ))}
    </div>
  );
}

const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();

/** Usage per period by provider, with each provider's mark in the hover split. */
export function UsageProviderChart({
  providers,
  loadingProviders = NONE_LOADING,
  daily,
  hourly,
  ...chart
}: UsageChartWindowProps & {
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
}) {
  const totals: readonly (DailyTotals | HourlyTotals)[] =
    chart.resolution === "hour" ? hourly : daily;
  const byPeriod = new Map(
    totals.map((entry) => ["hourStart" in entry ? entry.hourStart : entry.day, entry]),
  );
  const series = providers.map((provider): ChartSeries => {
    const { label, driverKind, color } = PROVIDER_PRESENTATION[provider];
    return {
      key: provider,
      label,
      color,
      icon: (
        <ProviderInstanceIcon driverKind={driverKind} displayName={label} iconClassName="size-3" />
      ),
      loading: loadingProviders.has(provider),
    };
  });
  return (
    <UsageStackedChart
      {...chart}
      series={series}
      caption={usageChartCaption(chart.metric, chart.resolution, "provider")}
      valueAt={(period, key) => {
        const entry = byPeriod.get(period)?.byProvider.get(key as UsageProviderKind);
        if (entry === undefined) return 0;
        return chart.metric === "tokens" ? entry.totalTokens : entry.costUsd;
      }}
    />
  );
}

export type UsageChartSplit = "provider" | "device" | "process" | "work" | "type";

/** The screen-reader caption of a chart's table, as a message. */
export function usageChartCaption(
  metric: UsageChartMetric,
  resolution: "day" | "hour",
  split: UsageChartSplit,
): string {
  const hourly = resolution === "hour";
  const tokens = metric === "tokens";
  switch (split) {
    case "provider":
      return hourly
        ? tokens
          ? msg("Hourly processed tokens by provider")
          : msg("Hourly cost by provider")
        : tokens
          ? msg("Daily processed tokens by provider")
          : msg("Daily cost by provider");
    case "device":
      return hourly
        ? tokens
          ? msg("Hourly processed tokens by device")
          : msg("Hourly cost by device")
        : tokens
          ? msg("Daily processed tokens by device")
          : msg("Daily cost by device");
    case "process":
      return hourly
        ? tokens
          ? msg("Hourly processed tokens by process")
          : msg("Hourly cost by process")
        : tokens
          ? msg("Daily processed tokens by process")
          : msg("Daily cost by process");
    case "work":
      return hourly
        ? tokens
          ? msg("Hourly processed tokens by kind of work")
          : msg("Hourly cost by kind of work")
        : tokens
          ? msg("Daily processed tokens by kind of work")
          : msg("Daily cost by kind of work");
    case "type":
      return hourly
        ? tokens
          ? msg("Hourly processed tokens by direction")
          : msg("Hourly cost by direction")
        : tokens
          ? msg("Daily processed tokens by direction")
          : msg("Daily cost by direction");
  }
}

/**
 * The bars a chart is leaving while it moves to new ones: the breakdown it showed, and how to move.
 * `switch` pours the new bars over the old, or morphs them between a stacked and a mirror chart;
 * `split` cross-fades them.
 */
export interface ChartTransition {
  readonly id: number;
  readonly kind: "switch" | "split";
  readonly series: readonly ChartSeries[];
  readonly valueAt: (period: string, key: string) => number;
}

/** Bars this many or fewer keep their own layer, so they draw the same moving and at rest. */
const LAYERED_BARS = 90;

function ChartBars({
  bars,
  widthPercent,
  dim,
  layered,
}: {
  readonly bars: readonly ChartBar[];
  readonly widthPercent: number;
  readonly dim: boolean;
  readonly layered: boolean;
}) {
  return (
    <div className="absolute inset-0 flex">
      {bars.map((bar, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a bar is its period's slot
        <div key={index} className="relative min-w-0 flex-1">
          <span
            data-chart-bar
            data-pour-from={bar.centre === undefined ? undefined : bar.centre.toFixed(2)}
            className={cn(
              "absolute bottom-0 left-1/2 block max-w-16 origin-bottom -translate-x-1/2 transition-opacity",
              layered && "will-change-transform",
              dim && "opacity-40 delay-150",
            )}
            style={{
              top: `${(bar.top / VIEW_HEIGHT) * 100}%`,
              bottom: `${(bar.bottom / VIEW_HEIGHT) * 100}%`,
              width: `${widthPercent}%`,
              background: bar.background,
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** Stacked bars of usage per period, one band per series, the first series on top. */
export function UsageStackedChart({
  series,
  valueAt,
  caption,
  days,
  hours,
  metric,
  referenceTime,
  resolution,
  timeZone,
  hour12,
  annotations = NO_ANNOTATIONS,
  annotationToggle,
  transition = null,
  onTransitionEnd,
}: UsageChartWindowProps & {
  readonly series: readonly ChartSeries[];
  readonly valueAt: (period: string, key: string) => number;
  /** A message for the screen-reader table's caption. */
  readonly caption: string;
  /** Set while the chart moves from another breakdown to this one. */
  readonly transition?: ChartTransition | null;
  readonly onTransitionEnd?: (id: number) => void;
  /** Drawn under the chart, where it stays whether or not the annotations show. */
  readonly annotationToggle?: ReactNode;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const periods = resolution === "hour" ? hours : days;
  const columns = buildPeriodColumns(periods, series, valueAt);
  const scale = chartScale(columns, series);
  const bars = buildBars(columns, series, scale.max);
  const outgoing =
    transition === null
      ? null
      : buildBars(
          buildPeriodColumns(periods, transition.series, transition.valueAt),
          transition.series,
          scale.max,
        );
  const geometry = barGeometry(periods.length);
  const widthPercent = (geometry.width / geometry.step) * 100;
  const layered = periods.length <= LAYERED_BARS;
  const dim = series.some((entry) => entry.loading === true);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const transitionEnded = useEffectEvent((id: number) => onTransitionEnd?.(id));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- plays a one-shot Web Animation on the bars React just drew
  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (transition === null || plot === null) return;
    const done = () => transitionEnded(transition.id);
    const layers = [...plot.querySelectorAll<HTMLElement>("[data-chart-layer]")];
    const barsOf = (layer: string) => [
      ...(layers
        .find((el) => el.dataset.chartLayer === layer)
        ?.querySelectorAll<HTMLElement>("[data-chart-bar]") ?? []),
    ];
    if (reducedMotion()) {
      done();
      return;
    }
    const old = barsOf("outgoing");
    const fresh = barsOf("current");
    // Only a mirror chart's bars mark their centre line.
    const mirrored = (bars: readonly HTMLElement[]) =>
      bars.some((bar) => bar.dataset.pourFrom !== undefined);
    void (
      transition.kind === "split"
        ? crossFade(old, fresh)
        : mirrored(old) === mirrored(fresh)
          ? pourOver(old, fresh)
          : morphBars(old, fresh)
    ).then(done);
  }, [transition]);

  // A mirror chart labels each tick above and below the centre line, in absolute values.
  const tickRows = scale.mirrored
    ? scale.ticks.flatMap((tick) =>
        tick === 0
          ? [{ key: "0", tick, y: MIRROR_MIDDLE }]
          : [
              { key: `up-${tick}`, tick, y: valueToY(tick, scale.max, "up") },
              { key: `down-${tick}`, tick, y: valueToY(tick, scale.max, "down") },
            ],
      )
    : scale.ticks.map((tick) => ({ key: String(tick), tick, y: valueToY(tick, scale.max) }));
  const format = metric === "tokens" ? formatTokens : (value: number) => formatUsd(value, locale);
  const formatPeriod = (period: string) =>
    resolution === "hour"
      ? formatHourShort(period, timeZone, hour12, locale)
      : formatDayShort(period, locale);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone, hour12, m, locale)
      : formatPeriod(period);
  const tickLabel = (tick: number) => (tick === 0 ? "0" : format(tick));

  return (
    // The y-axis column is as wide as its widest label, ending flush with the chart's right edge;
    // the plot takes the rest. It fills a taller column and never shrinks below h-56.
    // The chart keeps one height; the annotation toggle and the annotations go under it.
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid h-80 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] gap-x-2 gap-y-1">
        <div ref={plotRef} className="relative">
          <UsageChartPlot
            periods={periods}
            columns={columns}
            series={series}
            format={format}
            formatTooltipPeriod={formatTooltipPeriod}
          >
            {tickRows.map((row) => (
              <div
                key={row.key}
                className="absolute inset-x-0 h-px bg-border"
                style={{ top: `${(row.y / VIEW_HEIGHT) * 100}%` }}
              />
            ))}
            {outgoing === null ? null : (
              <div key={transition?.id} data-chart-layer="outgoing" className="absolute inset-0">
                <ChartBars
                  bars={outgoing}
                  widthPercent={widthPercent}
                  dim={false}
                  layered={layered}
                />
              </div>
            )}
            <div data-chart-layer="current" className="absolute inset-0">
              <ChartBars bars={bars} widthPercent={widthPercent} dim={dim} layered={layered} />
            </div>
          </UsageChartPlot>
        </div>
        <div aria-hidden className="relative text-3xs text-muted-foreground tabular-nums">
          {/* Sizes the column to the widest label; the shown labels sit on their ticks. */}
          <div className="invisible grid h-0 overflow-hidden">
            {scale.labeled
              ? scale.ticks.map((tick) => <span key={tick}>{tickLabel(tick)}</span>)
              : null}
          </div>
          {scale.labeled
            ? tickRows.map((row) => (
                <span
                  key={row.key}
                  className="absolute right-0 -translate-y-1/2 whitespace-nowrap"
                  style={{ top: `${(row.y / VIEW_HEIGHT) * 100}%` }}
                >
                  {tickLabel(row.tick)}
                </span>
              ))
            : null}
        </div>

        <div
          aria-hidden
          className="relative h-4 text-3xs whitespace-nowrap text-muted-foreground uppercase"
        >
          {axisLabelIndices(periods.length).map((index) => {
            // Past a week the edge bars hug the plot's sides, so their labels align to the sides.
            const pinned = periods.length > 7;
            const style =
              pinned && index === 0
                ? { left: 0 }
                : pinned && index === periods.length - 1
                  ? { right: 0 }
                  : { left: `${((index + 0.5) / periods.length) * 100}%`, translate: "-50% 0" };
            return (
              <span key={periods[index]} className="absolute" style={style}>
                {formatPeriod(periods[index] ?? "")}
              </span>
            );
          })}
        </div>
        <div />
      </div>
      {annotationToggle === undefined ? null : <div className="flex">{annotationToggle}</div>}
      {annotations.length === 0 ? null : (
        // The same columns as the chart: the y-axis labels size the right one.
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2">
          <UsageChartAnnotations
            placed={annotations}
            periodCount={periods.length}
            plotRef={plotRef}
            zeroY={scale.mirrored ? MIRROR_MIDDLE : VIEW_HEIGHT}
          />
          <div aria-hidden className="invisible grid h-0 overflow-hidden text-3xs tabular-nums">
            {scale.labeled
              ? scale.ticks.map((tick) => <span key={tick}>{tickLabel(tick)}</span>)
              : null}
          </div>
        </div>
      )}

      {/* The plot and its axes are hover-only; this carries the same figures for screen readers.
          sr-only sits on a wrapper: Firefox does not clip a table's caption by the table's own box. */}
      <div className="sr-only">
        <table>
          <caption>{m(caption)}</caption>
          <thead>
            <tr>
              <th scope="col">{resolution === "hour" ? gt("Hour") : gt("Day")}</th>
              {series.map((entry) => (
                <th key={entry.key} scope="col">
                  {entry.label}
                </th>
              ))}
              {series.length > 1 ? (
                <th scope="col">
                  <T>Total</T>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {periods.map((period, index) => {
              const column = columns[index];
              return (
                <tr key={period}>
                  <th scope="row">{formatTooltipPeriod(period)}</th>
                  {series.map((entry, slot) => (
                    <td key={entry.key}>{format(column?.bands[slot]?.value ?? 0)}</td>
                  ))}
                  {series.length > 1 ? <td>{format(column?.total ?? 0)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
