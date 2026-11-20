import "~/index.css";

import type { UsageDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageStackedChart, type ChartSeries, type ChartTransition } from "./UsageProviderChart";

const DAYS = ["2026-11-01", "2026-11-02", "2026-11-03"];
const STACKED: readonly ChartSeries[] = [
  { key: "a", label: "A", color: "red" },
  { key: "b", label: "B", color: "blue" },
];
const MIRROR: readonly ChartSeries[] = [
  { key: "a", label: "A", color: "red" },
  { key: "b", label: "B", color: "blue", below: true },
];
const valueAt = () => 10;

function chart(series: readonly ChartSeries[], transition: ChartTransition | null) {
  return (
    <UsageStackedChart
      series={series}
      valueAt={valueAt}
      caption="Usage"
      days={DAYS}
      hours={[]}
      metric="tokens"
      referenceTime={undefined}
      resolution="day"
      timeZone="UTC"
      hour12={false}
      annotations={[{ annotation: { date: "2026-11-02" as UsageDay, label: "Note" }, index: 1 }]}
      transition={transition}
    />
  );
}

describe("UsageStackedChart annotations", () => {
  it("moves an annotation's dot and line with the zero line as the chart turns mirror", async () => {
    await using screen = await render(chart(STACKED, null));
    const plot = screen.container.querySelector<HTMLElement>(
      '[data-chart-layer="current"]',
    )!.parentElement!;
    const dot = screen.container.querySelector<HTMLElement>(".rounded-full.size-1\\.5")!;
    const line = dot.previousElementSibling as HTMLElement;
    const centre = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    const foot = plot.getBoundingClientRect().bottom;
    expect(centre(dot)).toBeCloseTo(foot, 0);

    await screen.rerender(chart(MIRROR, { id: 1, kind: "switch", series: STACKED, valueAt }));
    const moves = [...dot.getAnimations(), ...line.getAnimations()];
    expect(moves).toHaveLength(2);
    for (const move of moves) {
      move.pause();
      move.currentTime = 0;
    }
    // As the bars start to morph, the anchor still stands on the old zero line, the foot.
    expect(centre(dot)).toBeCloseTo(foot, 0);
    expect(line.getBoundingClientRect().top).toBeCloseTo(foot, 0);

    for (const move of moves) move.finish();
    // A mirror chart's centre line, 134 of its 260 units down.
    const middle =
      plot.getBoundingClientRect().top + plot.getBoundingClientRect().height * (134 / 260);
    expect(centre(dot)).toBeCloseTo(middle, 0);
    expect(line.getBoundingClientRect().top).toBeCloseTo(middle, 0);
  });
});
