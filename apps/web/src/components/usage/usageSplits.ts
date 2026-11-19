import type { UsageDeviceBand } from "@t3tools/contracts";
import { OTHER_WORK, type UsageSplitBand } from "@t3tools/shared/usageMerge";
import { msg } from "gt-react";

/** What the Usage page's chart and the list beside it split usage by. */
export type UsageBreakdown = "provider" | "device" | "work";

export const BREAKDOWN_OPTIONS = [
  { value: "provider", label: msg("By provider", { $context: "usage breakdown option" }) },
  { value: "device", label: msg("By device", { $context: "usage breakdown option" }) },
  { value: "work", label: msg("By kind of work", { $context: "usage breakdown option" }) },
] as const satisfies readonly { value: UsageBreakdown; label: string }[];

/** A band as the page draws it. `label` is a message unless `named`. */
export interface UsageBand extends UsageSplitBand {
  readonly label: string;
  /** A user's own group name, shown as typed rather than translated. */
  readonly named: boolean;
  readonly color: string;
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;
const COMPUTER = "light-dark(oklch(0.55 0.19 264), oklch(0.66 0.17 264))";

// Amber and blue as on the origin bar; upkeep is the computer's own work, so a paler blue.
const DEVICE: Record<UsageDeviceBand, { readonly label: string; readonly color: string }> = {
  phone: {
    label: msg("Phone", { $context: "device a usage origin traces to" }),
    color: "light-dark(oklch(0.72 0.16 65), oklch(0.78 0.15 70))",
  },
  computer: {
    label: msg("Computer", { $context: "device a usage origin traces to" }),
    color: COMPUTER,
  },
  upkeep: {
    label: msg("Computer · upkeep", { $context: "usage band: the computer's own upkeep work" }),
    color: `color-mix(in oklab, ${COMPUTER} 45%, var(--background))`,
  },
  unlabelled: {
    label: msg("Unlabelled", { $context: "usage band: usage from before devices were recorded" }),
    color: ink(22),
  },
};

// Purple, blue and amber for the first three groups, as on the stacked-bar mock.
const GROUP_COLORS = ["#8c7bd1", "#5b9bbd", "#d4a548", "#4d9f8a", "#d97757", "#c06c9b"];
export const OTHER_WORK_LABEL = msg("Other", { $context: "usage kind of work: usage in no group" });
const OTHER = {
  label: OTHER_WORK_LABEL,
  color: ink(36),
};

export function presentBand(band: UsageSplitBand): UsageBand {
  if (band.groupIndex !== null) {
    return {
      ...band,
      label: band.key,
      named: true,
      color: GROUP_COLORS[band.groupIndex % GROUP_COLORS.length]!,
    };
  }
  const known =
    band.key === OTHER_WORK ? OTHER : (DEVICE[band.key as UsageDeviceBand] ?? DEVICE.unlabelled);
  return { ...band, label: known.label, named: false, color: known.color };
}
