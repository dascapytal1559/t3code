import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitAccount,
  type LimitPresentations,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { onClientClock } from "../usage/LimitsUpdated";
import { barColor, useLimitPresentations, usePaceMark } from "../usage/UsageLimits";
import { useUsageHiddenProviders } from "../usage/usagePagePreferences";

interface UsageRow {
  readonly account: LimitAccount;
  readonly providerLabel: string;
  readonly name: string;
  readonly window: ServerProviderUsageWindow;
  readonly remaining: number;
  readonly timeLeft: number | null;
}

/**
 * One row per account the Limits view shows, in its order: the account's own weekly window, or its
 * first one without a weekly. Accounts reset on their own clocks.
 */
function usageRows(presentations: LimitPresentations, now: number): readonly UsageRow[] {
  return collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) => {
    const providerLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
    return pool.accounts.flatMap((account) => {
      // A pool of one applies the page's per-driver window filtering and ordering to this account.
      const own = collectLimitPools([account], now)[0];
      const windows = own ? displayLimitWindows(own) : [];
      const window = (windows.find((entry) => entry.kind === "weekly") ?? windows[0])?.members[0]
        ?.window;
      if (!window) return [];
      return [
        {
          account,
          providerLabel,
          name: account.displayName ?? providerLabel,
          window,
          remaining: remainingPercent(window),
          timeLeft: paceRemainingPercent(window, now),
        },
      ];
    });
  });
}

function rowSummary(row: UsageRow, gt: ReturnType<typeof useGT>): string {
  return row.timeLeft === null
    ? gt("{name} {remaining}% left", { name: row.name, remaining: row.remaining })
    : gt("{name} {remaining}% left, {timeLeft}% of the window left", {
        name: row.name,
        remaining: row.remaining,
        timeLeft: row.timeLeft,
      });
}

function rowColor(row: UsageRow): string {
  return normalizeProviderAccentColor(row.account.accentColor) ?? barColor(row.account.driver);
}

export function SidebarUsageMini() {
  const presentations = useLimitPresentations(null, useUsageHiddenProviders());
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const gt = useGT();
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
            aria-label={gt("Usage: {summary}", {
              summary: rows.map((row) => rowSummary(row, gt)).join(", "),
            })}
            onClick={openUsage}
            className="flex w-full cursor-pointer flex-col gap-1.5 rounded-md px-2.5 py-1.5 outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        {rows.map((row) => (
          <span key={row.account.key} className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={row.account.driver}
              displayName={row.providerLabel}
              indicatorBackground="var(--sidebar)"
              className="size-3.5"
              iconClassName="size-3.5 text-sidebar-muted-foreground"
            />
            <UsageBar row={row} />
            <span className="w-8 shrink-0 text-right text-2xs text-sidebar-muted-foreground tabular-nums">
              {row.remaining}%
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
        {row.remaining > 0 ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full opacity-60"
            style={{ width: `${row.remaining}%`, backgroundColor: rowColor(row) }}
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
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="flex flex-col gap-2 text-xs">
      {rows.map((row) => {
        const age = formatRelativeTimeLabel(
          onClientClock(row.account.limits.checkedAt, row.account.checkedBy),
          now,
          m,
        );
        const details = [
          formatResetsIn(row.window, now, m),
          age && gt("updated {age}", { age }),
        ].filter(Boolean);
        return (
          <div key={row.account.key} className="flex flex-col gap-0.5">
            <span className="text-foreground">
              {row.timeLeft === null
                ? gt("{name} · {window} · {remaining}% left", {
                    name: row.name,
                    window: row.window.label,
                    remaining: row.remaining,
                  })
                : gt("{name} · {window} · {remaining}% left · {timeLeft}% of the window left", {
                    name: row.name,
                    window: row.window.label,
                    remaining: row.remaining,
                    timeLeft: row.timeLeft,
                  })}
            </span>
            <span className="text-muted-foreground tabular-nums">{details.join(" · ")}</span>
          </div>
        );
      })}
      {rows.some((row) => row.timeLeft !== null) ? (
        <span className="text-muted-foreground">
          <T>The line is where even spending would be.</T>
        </span>
      ) : null}
      <span className="text-muted-foreground">
        <T>Click to open Usage</T>
      </span>
    </div>
  );
}
