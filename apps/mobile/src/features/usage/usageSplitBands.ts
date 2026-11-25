import type { UsageDeviceBand, UsageProcessBand } from "@t3tools/contracts";
import {
  DEVICE_SPLIT_COLORS,
  OTHER_WORK_COLOR,
  PROCESS_SPLIT_COLORS,
  usageSplitHex,
  workGroupColors,
  type UsageSplitColor,
} from "@t3tools/client-runtime/usage-split-palette";
import { OTHER_WORK, type UsageSplitBand } from "@t3tools/shared/usageMerge";
import { msg } from "gt-react-native";

export type UsageBreakdown = "provider" | "device" | "process" | "work";

export const BREAKDOWN_OPTIONS = [
  { value: "provider", label: msg("Provider", { $context: "usage breakdown option" }) },
  { value: "work", label: msg("Kind of work", { $context: "usage breakdown option" }) },
  { value: "device", label: msg("Device", { $context: "usage breakdown option" }) },
  { value: "process", label: msg("Process", { $context: "usage breakdown option" }) },
] as const satisfies readonly { value: UsageBreakdown; label: string }[];

const DEVICE_LABEL: Record<UsageDeviceBand, string> = {
  phoneDirect: msg("Phone · direct", { $context: "usage band: prompts typed on the phone" }),
  phoneOrchestrated: msg("Phone · orchestrated", {
    $context: "usage band: work agents sent on behalf of a phone prompt",
  }),
  computerDirect: msg("Computer · direct", {
    $context: "usage band: prompts typed on the computer",
  }),
  computerOrchestrated: msg("Computer · orchestrated", {
    $context: "usage band: work agents sent on behalf of a computer prompt",
  }),
  unlabelled: msg("Unlabelled", {
    $context: "usage band: usage from before devices were recorded",
  }),
};
const OTHER_LABEL = msg("Other", { $context: "usage kind of work: usage in no group" });
const PROCESS_LABEL: Record<UsageProcessBand, string> = {
  journal: msg("Journal", {
    $context: "usage process: filing voice journals and their items' work",
  }),
  routines: msg("Routines", { $context: "usage process: upkeep such as the bedtime routine" }),
  incident: msg("Incidents", {
    $context: "usage process: handling production alerts and the fixes patched for them",
  }),
  other: msg("Direct", {
    $context: "usage process: usage that is neither journal nor routine",
  }),
};

// The screen's text over its background, which greys mix as on web.
const LIGHT = { foreground: "#27272a", background: "#fcfcfc" };
const DARK = { foreground: "#f5f5f5", background: "#0a0a0a" };

/** A band's label, as a message unless it is a user's group name, and its colour as on web. */
export function presentBand(
  breakdown: Exclude<UsageBreakdown, "provider">,
  band: UsageSplitBand,
  dark: boolean,
): { readonly label: string; readonly named: boolean; readonly color: string } {
  const hex = (color: UsageSplitColor) => usageSplitHex(color, dark, dark ? DARK : LIGHT);
  if (breakdown === "process") {
    const process = band.key in PROCESS_LABEL ? (band.key as UsageProcessBand) : "other";
    return {
      label: PROCESS_LABEL[process],
      named: false,
      color: hex(PROCESS_SPLIT_COLORS[process]),
    };
  }
  if (band.groupIndex !== null) {
    return {
      label: band.key,
      named: true,
      color: hex(workGroupColors(band.groupIndex, band.color).color),
    };
  }
  if (band.key === OTHER_WORK) {
    return { label: OTHER_LABEL, named: false, color: hex(OTHER_WORK_COLOR) };
  }
  const device = band.key in DEVICE_LABEL ? (band.key as UsageDeviceBand) : "unlabelled";
  return { label: DEVICE_LABEL[device], named: false, color: hex(DEVICE_SPLIT_COLORS[device]) };
}

/**
 * Bands top first as web lists them: largest first by the metric. A device's two bands stay
 * together, under the larger device first, as web's device card opens one device into them.
 */
export function orderBands<B extends UsageSplitBand>(
  breakdown: Exclude<UsageBreakdown, "provider">,
  bands: readonly B[],
  metric: "cost" | "tokens",
): readonly B[] {
  const valueOf = (band: B) => (metric === "cost" ? band.costUsd : band.totalTokens);
  if (breakdown !== "device") return [...bands].sort((a, b) => valueOf(b) - valueOf(a));
  const deviceOf = (band: B) => (band.key.startsWith("phone") ? "phone" : "computer");
  const deviceTotals = new Map<string, number>();
  for (const band of bands) {
    deviceTotals.set(deviceOf(band), (deviceTotals.get(deviceOf(band)) ?? 0) + valueOf(band));
  }
  const deviceRank = (band: B) => deviceTotals.get(deviceOf(band)) ?? 0;
  return [...bands].sort(
    (a, b) =>
      deviceRank(b) - deviceRank(a) ||
      Number(deviceOf(a) === "computer") - Number(deviceOf(b) === "computer") ||
      valueOf(b) - valueOf(a),
  );
}
