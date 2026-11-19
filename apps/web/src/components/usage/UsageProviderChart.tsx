import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { UsageAnnotation, UsageProviderKind } from "@t3tools/contracts";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

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

function chartScale(columns: readonly DayColumn[], series: readonly ChartSeries[]) {
  const peak = stackedPeak(columns);
  return peak === 0 && series.some((entry) => entry.loading === true)
    ? { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false }
    : { ...niceScale(peak, TICK_COUNT), labeled: true };
}

function valueToY(value: number, max: number) {
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

function buildChart(
  periods: readonly string[],
  series: readonly ChartSeries[],
  valueAt: (period: string, key: string) => number,
) {
  const columns = buildPeriodColumns(periods, series, valueAt);
  const scale = chartScale(columns, series);
  const bar = barGeometry(periods.length);
  const stacked = series
    .map((entry, slot) => ({
      entry,
      slot,
      total: columns.reduce((sum, column) => sum + (column.bands[slot]?.value ?? 0), 0),
    }))
    .toSorted((a, b) => b.total - a.total);

  // The largest series sits at the bottom of every bar; each series is one path.
  const paths = stacked.map(({ entry }) => ({ entry, d: "" }));
  const barTops: number[] = [];
  for (const [periodIndex, column] of columns.entries()) {
    const x = (periodIndex * bar.step + bar.inset).toFixed(2);
    let base = 0;
    for (const [stackIndex, { slot }] of stacked.entries()) {
      const value = column.bands[slot]?.value ?? 0;
      if (value <= 0) continue;
      const bottom = valueToY(base, scale.max);
      base += value;
      const top = valueToY(base, scale.max);
      const path = paths[stackIndex];
      if (path === undefined) continue;
      path.d += `M${x},${top.toFixed(2)}h${bar.width.toFixed(2)}V${bottom.toFixed(2)}h-${bar.width.toFixed(2)}Z`;
    }
    barTops.push(valueToY(base, scale.max));
  }

  return { columns, scale, bar, paths, barTops };
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
  step,
  series,
  format,
  formatTooltipPeriod,
  overlay,
  children,
}: {
  readonly periods: readonly string[];
  readonly columns: readonly DayColumn[];
  readonly step: number;
  readonly series: readonly ChartSeries[];
  readonly format: (value: number) => string;
  readonly formatTooltipPeriod: (period: string) => string;
  readonly overlay?: React.ReactNode;
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
      className="relative flex-1"
      onMouseMove={handleMove}
      onMouseLeave={() => {
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
    >
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {hoverIndex === null ? null : (
          <rect
            x={hoverIndex * step}
            y={0}
            width={step}
            height={VIEW_HEIGHT}
            fill="currentColor"
            fillOpacity={0.08}
            className="text-foreground"
          />
        )}
        {children}
      </svg>
      {overlay}

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

/** Each chip rises on a line from its date on the axis; it never takes pointer input from the plot. */
function UsageChartAnnotations({
  placed,
  periodCount,
  barTops,
}: {
  readonly placed: readonly PlacedUsageAnnotation[];
  readonly periodCount: number;
  /** Each period's bar top in chart units. */
  readonly barTops: readonly number[];
}) {
  const locale = useLocale();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places chips from measured chip and plot sizes through CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (layer === null) return;
    const position = () => {
      const chips = placed.map(({ index }, slot) => ({
        index,
        width: chipRefs.current[slot]?.offsetWidth ?? 0,
      }));
      const chipHeight = chipRefs.current[0]?.offsetHeight ?? 0;
      const plotHeight = layer.clientHeight;
      const layout = layoutAnnotationChips({
        chips,
        periodCount,
        plotWidth: layer.clientWidth,
        plotHeight,
        chipHeight,
        barTop: (index) => ((barTops[index] ?? VIEW_HEIGHT) / VIEW_HEIGHT) * plotHeight,
      });
      layout.forEach(({ left, top, x }, slot) => {
        layer.style.setProperty(`--annotation-${slot}-left`, `${left}px`);
        layer.style.setProperty(`--annotation-${slot}-top`, `${top}px`);
        layer.style.setProperty(`--annotation-${slot}-line-top`, `${top + chipHeight}px`);
        layer.style.setProperty(`--annotation-${slot}-x`, `${x}px`);
      });
    };
    position();
    return observeResize([layer], position);
  }, [placed, periodCount, barTops]);

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {placed.map(({ annotation }, slot) => (
        <div key={annotationKey(annotation)}>
          <div
            aria-hidden
            className="absolute bottom-0 w-px -translate-x-1/2 bg-foreground"
            style={{
              left: `var(--annotation-${slot}-x)`,
              top: `var(--annotation-${slot}-line-top)`,
            }}
          />
          <div
            aria-hidden
            className="absolute bottom-0 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-foreground"
            style={{ left: `var(--annotation-${slot}-x)` }}
          />
          <div
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

export type UsageChartSplit = "provider" | "device" | "work";

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
    case "work":
      return hourly
        ? tokens
          ? msg("Hourly processed tokens by kind of work")
          : msg("Hourly cost by kind of work")
        : tokens
          ? msg("Daily processed tokens by kind of work")
          : msg("Daily cost by kind of work");
  }
}

/** Stacked bars of usage per period, one band per series, largest at the bottom. */
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
}: UsageChartWindowProps & {
  readonly series: readonly ChartSeries[];
  readonly valueAt: (period: string, key: string) => number;
  /** A message for the screen-reader table's caption. */
  readonly caption: string;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const periods = resolution === "hour" ? hours : days;
  const { columns, scale, bar, paths, barTops } = buildChart(periods, series, valueAt);

  const toY = (value: number) => valueToY(value, scale.max);
  const seriesClassName = (loading: boolean | undefined) =>
    cn("transition-opacity", loading === true && "opacity-40 delay-150");
  const format = metric === "tokens" ? formatTokens : (value: number) => formatUsd(value, locale);
  const formatPeriod = (period: string) =>
    resolution === "hour"
      ? formatHourShort(period, timeZone, hour12, locale)
      : formatDayShort(period, locale);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone, hour12, m, locale)
      : formatPeriod(period);

  return (
    // Fills a taller column, such as a long providers list beside it, and never shrinks below h-56.
    <div className="flex flex-1 flex-col gap-1">
      <div className="flex min-h-56 flex-1 gap-2">
        <UsageChartPlot
          periods={periods}
          columns={columns}
          step={bar.step}
          series={series}
          format={format}
          formatTooltipPeriod={formatTooltipPeriod}
          overlay={
            annotations.length === 0 ? undefined : (
              <UsageChartAnnotations
                placed={annotations}
                periodCount={periods.length}
                barTops={barTops}
              />
            )
          }
        >
          {scale.ticks.map((tick) => {
            const y = toY(tick);
            return (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {paths.map(({ entry, d }) => (
            <path
              key={entry.key}
              d={d}
              className={seriesClassName(entry.loading)}
              fill={entry.color}
            />
          ))}
        </UsageChartPlot>
        <div aria-hidden className="relative w-14 shrink-0">
          {scale.labeled
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute left-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))
            : null}
        </div>
      </div>

      <div
        aria-hidden
        className="relative mr-16 h-4 text-3xs whitespace-nowrap text-muted-foreground uppercase"
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
