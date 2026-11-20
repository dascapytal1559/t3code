import { msg } from "gt-react";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";
import { m, type MessageResolver } from "../../i18n/messages";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: msg("Cost"), command: "usage.cost" },
  { value: "tokens", label: msg("Tokens"), command: "usage.tokens" },
  { value: "limits", label: msg("Limits"), command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const WINDOW_OPTIONS = [
  { days: 1, label: msg("Past 24h"), command: "usage.period.day" },
  { days: 7, label: msg("7 days"), command: "usage.period.week" },
  { days: 30, label: msg("30 days"), command: "usage.period.month" },
  { days: 90, label: msg("90 days"), command: "usage.period.quarter" },
  { days: 180, label: msg("6 months"), command: "usage.period.halfYear" },
  { days: 365, label: msg("12 months"), command: "usage.period.year" },
] as const;

export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
) {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest(
        '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal]), [aria-haspopup]:not([aria-haspopup="false"]), [role="listbox"], [role="menu"]',
      ) ||
      (event.key.startsWith("Arrow") &&
        target.closest('[role="radiogroup"], [role="tablist"], [data-slot="toggle-group"]')))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}

export function usageChartTitle(
  metric: UsageChartMetric,
  hourly: boolean,
  dayCount: number,
  resolve: MessageResolver = m,
) {
  if (hourly) {
    return metric === "tokens"
      ? resolve(msg("Processed tokens, last 24 hours"))
      : resolve(msg("Cost, last 24 hours"));
  }
  const option = WINDOW_OPTIONS.find((candidate) => candidate.days === dayCount);
  const period = option
    ? resolve(option.label)
    : resolve(msg("{count, plural, one {{count} day} other {{count} days}}"), { count: dayCount });
  return metric === "tokens"
    ? resolve(msg("Daily processed tokens over {period}"), { period })
    : resolve(msg("Daily cost over {period}"), { period });
}
