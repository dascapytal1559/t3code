import type { UsageDeviceBand } from "@t3tools/contracts";
import { OTHER_WORK, type UsageSplitBand } from "@t3tools/shared/usageMerge";
import { msg } from "gt-react-native";

export type UsageBreakdown = "provider" | "device" | "work";

export const BREAKDOWN_OPTIONS = [
  { value: "provider", label: msg("Provider", { $context: "usage breakdown option" }) },
  { value: "device", label: msg("Device", { $context: "usage breakdown option" }) },
  { value: "work", label: msg("Kind of work", { $context: "usage breakdown option" }) },
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

// The web page's hues: purple, blue and amber for the first groups.
const GROUP_COLORS = ["#8c7bd1", "#5b9bbd", "#d4a548", "#4d9f8a", "#d97757", "#c06c9b"];

// Amber phone and blue computer as on web; paler when an agent sent the prompt.
function deviceColor(band: UsageDeviceBand, dark: boolean): string {
  switch (band) {
    case "phoneDirect":
      return dark ? "#e6a54a" : "#d98a2b";
    case "phoneOrchestrated":
      return dark ? "#74593a" : "#efc795";
    case "computerDirect":
      return dark ? "#6f8cf0" : "#3f63d8";
    case "computerOrchestrated":
      return dark ? "#3a4874" : "#a6b6ee";
    case "unlabelled":
      return dark ? "#4a4a4a" : "#c4c4c4";
  }
}

/** A band's label, as a message unless it is a user's group name, and its colour. */
export function presentBand(
  band: UsageSplitBand,
  dark: boolean,
): { readonly label: string; readonly named: boolean; readonly color: string } {
  if (band.groupIndex !== null) {
    return { label: band.key, named: true, color: GROUP_COLORS[band.groupIndex % 6]! };
  }
  if (band.key === OTHER_WORK) {
    return { label: OTHER_LABEL, named: false, color: dark ? "#5c5c5c" : "#a3a3a3" };
  }
  const device = band.key in DEVICE_LABEL ? (band.key as UsageDeviceBand) : "unlabelled";
  return { label: DEVICE_LABEL[device], named: false, color: deviceColor(device, dark) };
}
