import { Chart, Host, type ChartDataPoint } from "@expo/ui/swift-ui";
import { frame } from "@expo/ui/swift-ui/modifiers";

import { buildChartDays } from "./usageChartData";
import type { UsageDailyChartProps } from "./UsageDailyChart";

export function UsageDailyChart({ days, series, valueAt, height }: UsageDailyChartProps) {
  const data: ChartDataPoint[] = buildChartDays(days, series, valueAt).flatMap((day) =>
    day.values.map((entry) => ({ x: day.day, y: entry.value, color: entry.color })),
  );

  return (
    <Host style={{ height, width: "100%" }}>
      <Chart
        type="bar"
        data={data}
        animate
        showGrid={false}
        barStyle={{ cornerRadius: 2 }}
        modifiers={[frame({ height })]}
      />
    </Host>
  );
}
