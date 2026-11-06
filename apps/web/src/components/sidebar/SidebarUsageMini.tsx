import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  formatResetsIn,
  type LimitAccount,
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
import { barColor, useLimitPresentations } from "../usage/UsageLimits";
import { useUsageHiddenProviders } from "../usage/usagePagePreferences";

interface UsageRow {
  readonly pool: LimitPool;
  readonly label: string;
  readonly window: LimitPoolWindow;
}

/** One row per provider the Limits view shows: its weekly window, or its first one without a weekly. */
function usageRows(presentations: LimitPresentations, now: number): readonly UsageRow[] {
  return collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) => {
    const windows = displayLimitWindows(pool);
    const window = windows.find((entry) => entry.kind === "weekly") ?? windows[0];
    if (!window) return [];
    const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
    return [{ pool, label, window }];
  });
}

function accountColor(account: LimitAccount): string {
  return normalizeProviderAccentColor(account.accentColor) ?? barColor(account.driver);
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
            aria-label={`Usage: ${rows
              .map((row) => `${row.label} ${row.window.remainingPercent}% left`)
              .join(", ")}`}
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
            <span
              className="grid min-w-0 flex-1 gap-x-0.5"
              style={{
                gridTemplateColumns: `repeat(${row.window.columns.length}, minmax(0, 1fr))`,
              }}
            >
              {row.window.columns.map((column) => {
                const remaining = column.window ? remainingPercent(column.window) : 0;
                return (
                  <span
                    key={column.account.key}
                    data-usage-segment
                    className="relative h-1.5 overflow-hidden rounded-full bg-foreground/8"
                  >
                    {remaining > 0 ? (
                      <span
                        className="absolute inset-y-0 left-0 rounded-full opacity-60"
                        style={{
                          width: `${remaining}%`,
                          backgroundColor: accountColor(column.account),
                        }}
                      />
                    ) : null}
                  </span>
                );
              })}
            </span>
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

/** Mounts on each open, so reset times count from when it opened. */
function UsageTooltip({ rows }: { readonly rows: readonly UsageRow[] }) {
  const [now] = useState(Date.now);
  return (
    <div className="flex flex-col gap-2 text-xs">
      {rows.map((row) => (
        <div key={row.pool.driver} className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {row.label} · {row.window.label} · {row.window.remainingPercent}% left
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
      <span className="text-muted-foreground">Click to open Usage</span>
    </div>
  );
}
