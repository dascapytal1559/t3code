import { View } from "react-native";

import { buildChartDays, type UsageChartSeries } from "./usageChartData";

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  /** Bottom first. */
  readonly series: readonly UsageChartSeries[];
  readonly valueAt: (period: string, key: string) => number;
  readonly height: number;
}

export function UsageDailyChart({ days, series, valueAt, height }: UsageDailyChartProps) {
  const chartDays = buildChartDays(days, series, valueAt);
  const max = chartDays.reduce((peak, day) => Math.max(peak, day.total), 0);

  return (
    <View style={{ height }} className="flex-row items-end gap-px">
      {/* Use column-reverse: series are bottom-first and Hermes lacks toReversed. */}
      {chartDays.map((day) => (
        <View
          key={day.day}
          style={{ height: max === 0 ? 0 : (day.total / max) * height }}
          className="flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
        >
          {day.values.map((entry) => (
            <View
              key={entry.key}
              style={{
                height: max === 0 ? 0 : (entry.value / max) * height,
                backgroundColor: entry.color,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
