import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  elapsedShare,
  formatResetsIn,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor, useLimitPresentations, usePaceMark } from "../usage/UsageLimits";
import { useUsageHiddenProviders } from "../usage/usagePagePreferences";

interface UsageRow {
  readonly pool: LimitPool;
  readonly label: string;
  readonly window: LimitPoolWindow;
  /** Share of the window still to run, from the mean elapsed share of the accounts with a clock. */
  readonly timeLeft: number | null;
}

function windowTimeLeft(window: LimitPoolWindow, now: number): number | null {
  const shares = window.members.flatMap((member) => elapsedShare(member.window, now) ?? []);
  if (shares.length === 0) return null;
  const mean = shares.reduce((sum, share) => sum + share, 0) / shares.length;
  return Math.round((1 - mean) * 100);
}

/** One row per provider the Limits view shows: its weekly window, or its first one without a weekly. */
function usageRows(presentations: LimitPresentations, now: number): readonly UsageRow[] {
  return collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) => {
    const windows = displayLimitWindows(pool);
    const window = windows.find((entry) => entry.kind === "weekly") ?? windows[0];
    if (!window) return [];
    const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
    return [{ pool, label, window, timeLeft: windowTimeLeft(window, now) }];
  });
}

function rowSummary(row: UsageRow): string {
  return `${row.label} ${row.window.remainingPercent}% left${
    row.timeLeft === null ? "" : `, ${row.timeLeft}% of the window left`
  }`;
}

/** The first account's accent, so a single-account row keeps its colour; pooled accounts share it. */
function rowColor(row: UsageRow): string {
  const account = row.window.columns[0]?.account;
  return (
    (account && normalizeProviderAccentColor(account.accentColor)) ?? barColor(row.pool.driver)
  );
}

export function SidebarUsageMini() {
  const presentations = useLimitPresentations(null, useUsageHiddenProviders());
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [mountedAt] = useState(Date.now);
  const rows = usageRows(presentations, mountedAt);
  if (rows.length === 0) return null;

  const openUsage = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-sidebar-usage
            aria-label={`Usage: ${rows.map(rowSummary).join(", ")}`}
            onClick={openUsage}
            className="flex w-full cursor-pointer flex-col gap-1.5 rounded-md px-2.5 py-1.5 outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        {rows.map((row) => (
          <span key={row.pool.driver} className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={row.pool.driver}
              displayName={row.label}
              indicatorBackground="var(--sidebar)"
              className="size-3.5"
              iconClassName="size-3.5 text-sidebar-muted-foreground"
            />
            <UsageBar row={row} />
            <span className="w-8 shrink-0 text-right text-2xs text-sidebar-muted-foreground tabular-nums">
              {row.window.remainingPercent}%
            </span>
          </span>
        ))}
      </TooltipTrigger>
      <TooltipPopup side="top" align="start">
        <UsageTooltip rows={rows} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** The tick marks where the bar would be if usage kept pace with the window, as on the Usage page. */
function UsageBar({ row }: { readonly row: UsageRow }) {
  const [barRef, paceMark] = usePaceMark(row.timeLeft);
  return (
    <span ref={barRef} data-usage-segment className="relative h-1.5 min-w-0 flex-1">
      <span
        className="absolute inset-0 overflow-hidden rounded-full bg-foreground/8"
        style={paceMark?.gap}
      >
        {row.window.remainingPercent > 0 ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full opacity-60"
            style={{ width: `${row.window.remainingPercent}%`, backgroundColor: rowColor(row) }}
          />
        ) : null}
      </span>
      {paceMark ? (
        <span
          aria-hidden
          data-usage-pace
          className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
          style={paceMark.tick}
        />
      ) : null}
    </span>
  );
}

/** Mounts on each open, so reset times count from when it opened. */
function UsageTooltip({ rows }: { readonly rows: readonly UsageRow[] }) {
  const [now] = useState(Date.now);
  return (
    <div className="flex flex-col gap-2 text-xs">
      {rows.map((row) => (
        <div key={row.pool.driver} className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {row.label} · {row.window.label} · {row.window.remainingPercent}% left
            {row.timeLeft === null ? "" : ` · ${row.timeLeft}% of the window left`}
          </span>
          {row.window.columns.map((column, index) => {
            const resetsIn = column.window ? formatResetsIn(column.window, now) : null;
            const name =
              row.window.columns.length > 1
                ? `${column.account.displayName ?? `Account ${index + 1}`}: ${
                    column.window ? `${remainingPercent(column.window)}% left` : "no data"
                  }`
                : null;
            if (!name && !resetsIn) return null;
            return (
              <span key={column.account.key} className="text-muted-foreground tabular-nums">
                {[name, resetsIn].filter(Boolean).join(" · ")}
              </span>
            );
          })}
        </div>
      ))}
      {rows.some((row) => row.timeLeft !== null) ? (
        <span className="text-muted-foreground">The line is where even spending would be.</span>
      ) : null}
      <span className="text-muted-foreground">Click to open Usage</span>
    </div>
  );
}
