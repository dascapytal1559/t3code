import { formatPercent, formatTokens, formatUsdShort } from "@t3tools/shared/usageFormat";
import { T, useGT, useLocale, useMessages } from "gt-react";

import { cn } from "../../lib/utils";
import { emphasisColor, emphasisPositions, isTopLeague } from "./usageEmphasis";
import type { UsageBand } from "./usageSplits";

/** The device or kind-of-work bands beside the chart, in the shape of its provider rows. */
export function UsageBandList({
  bands,
  metric,
  totalCostUsd,
  totalTokens,
  spread,
  loading,
}: {
  readonly bands: readonly UsageBand[];
  readonly metric: "cost" | "tokens";
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  /** Shared kinds of work the bands carry, as shown. */
  readonly spread: readonly string[];
  readonly loading: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const emphasis = emphasisPositions(
    bands.map((band) => (metric === "cost" ? band.costUsd : band.totalTokens)),
  );
  const figures = cn("transition-opacity", loading && "opacity-40 delay-150");
  if (bands.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <T>No activity in this window.</T>
      </p>
    );
  }
  const rows = bands.map((band, index) => {
    const position = emphasis[index] ?? 1;
    const share =
      metric === "cost"
        ? totalCostUsd === 0
          ? 0
          : band.costUsd / totalCostUsd
        : totalTokens === 0
          ? 0
          : band.totalTokens / totalTokens;
    return (
      <div key={band.key} className="flex min-w-0 flex-col gap-1">
        <dl className="flex items-baseline justify-between gap-4">
          <dt className="flex min-w-0 items-center gap-2 text-sm text-foreground">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: band.color }}
            />
            <span className="truncate">{band.named ? band.label : m(band.label)}</span>
          </dt>
          <dd
            className={cn(
              "shrink-0 text-base tabular-nums",
              isTopLeague(position) ? "font-semibold" : "font-medium",
              figures,
            )}
            style={{ color: emphasisColor(position) }}
          >
            {metric === "cost"
              ? formatUsdShort(band.costUsd, locale)
              : formatTokens(band.totalTokens)}
          </dd>
        </dl>
        <p
          className={cn(
            "flex justify-between gap-4 text-xs text-muted-foreground tabular-nums",
            figures,
          )}
        >
          <span className="min-w-0 truncate">
            {metric === "cost"
              ? gt("{tokens} tokens", { tokens: formatTokens(band.totalTokens) })
              : formatUsdShort(band.costUsd, locale)}
          </span>
          <span className="shrink-0">{formatPercent(share)}</span>
        </p>
      </div>
    );
  });
  if (spread.length === 0) return rows;
  return (
    <>
      {rows}
      <p className="text-xs text-muted-foreground">
        {gt("Spread across these groups: {kinds}", {
          kinds: new Intl.ListFormat(locale, { type: "conjunction" }).format(spread),
        })}
      </p>
    </>
  );
}
