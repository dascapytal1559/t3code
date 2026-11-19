export type UsageChartMetric = "cost" | "tokens";

/** One band of the stacked bars: a provider, a device or a kind of work. */
export interface UsageChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export interface UsageChartDay {
  readonly day: string;
  readonly values: readonly {
    readonly key: string;
    readonly color: string;
    readonly value: number;
  }[];
  readonly total: number;
}

export function buildChartDays(
  days: readonly string[],
  series: readonly UsageChartSeries[],
  valueAt: (period: string, key: string) => number,
): readonly UsageChartDay[] {
  return days.map((day) => {
    const values = series.map(({ key, color }) => ({ key, color, value: valueAt(day, key) }));
    return { day, values, total: values.reduce((sum, entry) => sum + entry.value, 0) };
  });
}
