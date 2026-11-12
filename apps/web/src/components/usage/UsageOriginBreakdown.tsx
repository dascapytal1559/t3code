import type { UsageOrigin, UsageOriginBasis } from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { MergedOrigins, OriginBasisTotals } from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const ORIGIN_PRESENTATION: Record<UsageOrigin, { readonly label: string; readonly color: string }> =
  {
    phone: { label: "Phone", color: ink(100) },
    computer: { label: "Computer", color: ink(70) },
    agent: { label: "Agent", color: ink(45) },
    crew: { label: "FirstMate crew", color: ink(28) },
    unknown: { label: "Unknown", color: ink(16) },
  };

const BASIS_LABEL: Record<UsageOriginBasis, string> = {
  stamp: "stamped",
  nativeApp: "from the phone app, before stamps",
  sender: "sent by an agent, before stamps",
  server: "made by the server",
  unstamped: "sent before stamps",
  noPrompt: "run's prompt is gone",
};

function basisLine(origin: UsageOrigin, bases: readonly OriginBasisTotals[]): string {
  const parts = bases.map(({ basis, prompts }) => {
    const label =
      origin === "unknown" && basis === "stamp" ? "stamped, device unknown" : BASIS_LABEL[basis];
    return prompts > 0 ? `${formatCount(prompts)} ${label}` : label;
  });
  if (origin === "crew") {
    parts.push("which device started the FirstMate thread's work is not recorded yet");
  }
  return parts.join(" · ");
}

interface OriginRow {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly detail: string;
  readonly prompts: number | null;
  readonly costUsd: number;
  readonly totalTokens: number;
  /** Shown under "Not tied to a device" rather than as a device bucket. */
  readonly gap: boolean;
}

export function UsageOriginBreakdown({
  origins,
  metric,
  totalCostUsd,
  totalTokens,
  loading,
}: {
  readonly origins: MergedOrigins;
  readonly metric: "tokens" | "cost";
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly loading: boolean;
}) {
  const rows: OriginRow[] = origins.rows.map((row) => ({
    key: row.origin,
    label: ORIGIN_PRESENTATION[row.origin].label,
    color: ORIGIN_PRESENTATION[row.origin].color,
    detail: basisLine(row.origin, row.bases),
    prompts: row.prompts,
    costUsd: row.costUsd,
    totalTokens: row.totalTokens,
    gap: row.origin === "crew",
  }));
  if (origins.unlinkedTokens > 0 || origins.unlinkedCostUsd > 0) {
    rows.push({
      key: "unlinked",
      label: "Outside T3 runs",
      color: "transparent",
      detail: "terminal sessions, archives, other machines and servers without origins",
      prompts: null,
      costUsd: origins.unlinkedCostUsd,
      totalTokens: origins.unlinkedTokens,
      gap: true,
    });
  }
  const devices = rows.filter((row) => !row.gap);
  const gaps = rows.filter((row) => row.gap);
  const valueOf = (row: OriginRow) => (metric === "tokens" ? row.totalTokens : row.costUsd);
  const total = metric === "tokens" ? totalTokens : totalCostUsd;
  const peak = rows.reduce((max, row) => Math.max(max, valueOf(row)), 0);
  const format = metric === "tokens" ? formatTokens : formatUsd;

  const renderRow = (row: OriginRow) => {
    const value = valueOf(row);
    return (
      <tr
        key={row.key}
        className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums"
      >
        <td className="py-2.5 pl-2 text-left whitespace-normal">
          <span className="flex items-center gap-2 text-foreground">
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                row.key === "unlinked" && "border border-muted-foreground/60",
              )}
              style={{ backgroundColor: row.color }}
            />
            {row.label}
          </span>
          <span className="mt-0.5 block ps-4 text-xs text-muted-foreground">{row.detail}</span>
          {value > 0 && peak > 0 ? (
            <div aria-hidden className={cn("mt-1.5 ms-4 h-0.5 max-w-48", figureClass(loading))}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `max(0.5rem, ${(value / peak) * 100}%)`,
                  backgroundColor: row.key === "unlinked" ? ink(16) : row.color,
                }}
              />
            </div>
          ) : null}
        </td>
        <td className={cn("py-2.5 pl-6 align-top text-foreground", figureClass(loading))}>
          {row.prompts === null ? "–" : formatCount(row.prompts)}
        </td>
        <td className={cn("hidden py-2.5 pl-6 align-top sm:table-cell", figureClass(loading))}>
          {total > 0 ? formatPercent(value / total) : ""}
        </td>
        <td className={cn("py-2.5 pr-2 pl-6 align-top text-foreground", figureClass(loading))}>
          {format(value)}
        </td>
      </tr>
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">By origin</h2>
        <p className="text-xs text-muted-foreground">
          Where each prompt was sent from, and the {metric === "tokens" ? "tokens" : "cost"} of the
          runs those prompts started.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="w-full py-2 pl-2 text-left font-normal">Sent from</th>
            <th className="py-2 pl-6 font-normal">Prompts</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Share</th>
            <th className="py-2 pr-2 pl-6 font-normal">
              {metric === "tokens" ? "Tokens" : "Cost"}
            </th>
          </tr>
        </thead>
        <tbody>
          {devices.map(renderRow)}
          {gaps.length > 0 ? (
            <tr>
              <th
                colSpan={4}
                scope="colgroup"
                className="pt-4 pb-1 pl-2 text-left text-xs font-normal text-muted-foreground"
              >
                Not tied to a device
              </th>
            </tr>
          ) : null}
          {gaps.map(renderRow)}
        </tbody>
      </table>
    </section>
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}
