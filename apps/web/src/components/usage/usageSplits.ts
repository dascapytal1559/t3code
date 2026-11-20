import type { UsageProcessBand, UsageProviderKind } from "@t3tools/contracts";
import {
  DEVICE_SPLIT_COLORS,
  OTHER_WORK_COLOR,
  PROCESS_SPLIT_COLORS,
  WORK_GROUP_PALETTE,
  darkLightness,
  type UsageSplitColor,
} from "@t3tools/client-runtime/usage-split-palette";
import {
  OTHER_WORK,
  usageMemberBands,
  usageSplitBands,
  type MergedDeviceBand,
  type MergedUsage,
  type UsageTypeBand,
} from "@t3tools/shared/usageMerge";
import { msg } from "gt-react";

/** The breakdown boxes beside the Usage chart, in page order; the open one is the chart's split. */
export type UsageBreakdown = "provider" | "device" | "process" | "work" | "type";
export const BREAKDOWN_ORDER: readonly UsageBreakdown[] = [
  "provider",
  "device",
  "work",
  "process",
  "type",
];

export const BREAKDOWN_TITLES = {
  tokens: {
    provider: msg("Tokens by provider"),
    device: msg("Tokens by device"),
    process: msg("Tokens by process"),
    work: msg("Tokens by kind of work"),
    type: msg("Tokens by type"),
  },
  cost: {
    provider: msg("Cost by provider"),
    device: msg("Cost by device"),
    process: msg("Cost by process"),
    work: msg("Cost by kind of work"),
    type: msg("Cost by type"),
  },
} as const satisfies Record<"tokens" | "cost", Record<UsageBreakdown, string>>;

/** One row of a box: a leaf band, or a parent's child. `label` is a message unless `named`. */
export interface BoxBand {
  readonly key: string;
  readonly label: string;
  readonly named: boolean;
  readonly color: string;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/** A parent row: a band of its own, and the children it opens into. */
export interface BoxGroup extends BoxBand {
  /** Every child, hidden ones included: they keep their colour in the bar and the chart. */
  readonly children: readonly BoxBand[];
  /** Children that count to the parent but get no row. */
  readonly hidden: ReadonlySet<string>;
}

export interface BoxModel {
  readonly kind: UsageBreakdown;
  /** Rows in card order. A box with no group that has children is flat. */
  readonly groups: readonly BoxGroup[];
  /** A group's or child's value in one day or hour; keys as the groups and children carry them. */
  readonly valueAt: (period: string, key: string, metric: "cost" | "tokens") => number;
  /** Shared kinds of work spread over the rows, `OTHER_WORK` for Other; empty for other boxes. */
  readonly spread?: readonly string[];
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;
const css = (color: UsageSplitColor) =>
  "ink" in color
    ? ink(color.ink)
    : `light-dark(oklch(${color.lightness} ${color.chroma} ${color.hue}), oklch(${darkLightness(color.lightness)} ${color.chroma} ${color.hue}))`;

// The device box lists the children in `DEVICE_BAND_ORDER`, as mobile stacks them.
const DEVICE_GROUPS = [
  {
    key: "phone",
    label: msg("Phone", { $context: "device a usage origin traces to" }),
    color: css(DEVICE_SPLIT_COLORS.phone),
    children: [
      {
        key: "phoneOrchestrated",
        label: msg("Orchestrated", { $context: "usage sent by an agent for a person's prompt" }),
        color: css(DEVICE_SPLIT_COLORS.phoneOrchestrated),
      },
      {
        key: "phoneDirect",
        label: msg("Direct", { $context: "usage from a prompt a person typed" }),
        color: css(DEVICE_SPLIT_COLORS.phoneDirect),
      },
    ],
  },
  {
    key: "computer",
    label: msg("Computer", { $context: "device a usage origin traces to" }),
    color: css(DEVICE_SPLIT_COLORS.computer),
    children: [
      {
        key: "computerDirect",
        label: msg("Direct", { $context: "usage from a prompt a person typed" }),
        color: css(DEVICE_SPLIT_COLORS.computerDirect),
      },
      {
        key: "computerOrchestrated",
        label: msg("Orchestrated", { $context: "usage sent by an agent for a person's prompt" }),
        color: css(DEVICE_SPLIT_COLORS.computerOrchestrated),
      },
    ],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  color: string;
  children: readonly { key: MergedDeviceBand; label: string; color: string }[];
}[];

const PROCESSES: readonly { key: UsageProcessBand; label: string; color: string }[] = [
  {
    key: "journal",
    label: msg("Journal", {
      $context: "usage process: filing voice journals and their items' work",
    }),
    color: css(PROCESS_SPLIT_COLORS.journal),
  },
  {
    key: "routines",
    label: msg("Routines", { $context: "usage process: upkeep such as the bedtime routine" }),
    color: css(PROCESS_SPLIT_COLORS.routines),
  },
  {
    key: "other",
    label: msg("Other", { $context: "usage process: usage that is neither journal nor routine" }),
    color: css(PROCESS_SPLIT_COLORS.other),
  },
];

const GROUP_PALETTE = WORK_GROUP_PALETTE.map((group) => ({
  color: css(group.color),
  members: group.members.map(css),
}));
const OTHER_WORK_CSS = css(OTHER_WORK_COLOR);

export const OTHER_WORK_LABEL = msg("Other", { $context: "usage kind of work: usage in no group" });

// Greys from usageBreakdown.ts, in its token-type order; cost no category accounts for is Other.
const TYPES: readonly { key: UsageTypeBand; label: string; color: string }[] = [
  { key: "input", label: msg("Input"), color: ink(60) },
  { key: "cacheRead", label: msg("Cache read"), color: ink(30) },
  { key: "output", label: msg("Output"), color: ink(100) },
  { key: "cacheWrite", label: msg("Cache write"), color: ink(72) },
  { key: "other", label: msg("Other"), color: ink(44) },
];

const value = (band: { totalTokens: number; costUsd: number }, metric: "cost" | "tokens") =>
  metric === "cost" ? band.costUsd : band.totalTokens;

const leaf = (band: BoxBand): BoxGroup => ({ ...band, children: [], hidden: new Set() });

/** The device box: phone and computer, each opening into prompts typed there and sent by agents. */
export function deviceBox(
  usage: MergedUsage,
  metric: "cost" | "tokens",
  hourly: boolean,
): BoxModel {
  const split = usageSplitBands(usage, "device", metric, hourly);
  const amountOf = (key: string) =>
    split.bands.find((band) => band.key === key) ?? { totalTokens: 0, costUsd: 0 };
  const groups = DEVICE_GROUPS.map((group): BoxGroup => {
    const children = group.children.map((child) => ({
      ...child,
      named: false,
      ...amountOf(child.key),
    }));
    return {
      key: group.key,
      label: group.label,
      named: false,
      color: group.color,
      totalTokens: children.reduce((sum, child) => sum + child.totalTokens, 0),
      costUsd: children.reduce((sum, child) => sum + child.costUsd, 0),
      children: children.filter((child) => child.totalTokens > 0 || child.costUsd > 0),
      hidden: new Set(),
    };
  }).filter((group) => group.totalTokens > 0 || group.costUsd > 0);
  const childrenOf = new Map<string, readonly string[]>(
    DEVICE_GROUPS.map((group) => [group.key, group.children.map((child) => child.key)]),
  );
  return {
    kind: "device",
    groups,
    valueAt: (period, key, by) => {
      const children = childrenOf.get(key);
      return children === undefined
        ? split.valueAt(period, key, by)
        : children.reduce((sum, child) => sum + split.valueAt(period, child, by), 0);
    },
  };
}

/** The process box: journal, routines and other, in that order. */
export function processBox(
  usage: MergedUsage,
  metric: "cost" | "tokens",
  hourly: boolean,
): BoxModel {
  const split = usageSplitBands(usage, "process", metric, hourly);
  const groups = PROCESSES.map((process) => {
    const band = split.bands.find((entry) => entry.key === process.key);
    return leaf({
      ...process,
      named: false,
      totalTokens: band?.totalTokens ?? 0,
      costUsd: band?.costUsd ?? 0,
    });
  }).filter((group) => group.totalTokens > 0 || group.costUsd > 0);
  return { kind: "process", groups, valueAt: split.valueAt };
}

/**
 * The kind-of-work box: groups largest first and Other last, each opening into its members, named
 * and hidden as the server's settings say.
 */
export function workBox(usage: MergedUsage, metric: "cost" | "tokens", hourly: boolean): BoxModel {
  const split = usageSplitBands(usage, "work", metric, hourly);
  const memberSplits = new Map<string, ReturnType<typeof usageMemberBands>>();
  const groups = split.bands.map((band): BoxGroup => {
    const palette =
      band.groupIndex === null ? null : GROUP_PALETTE[band.groupIndex % GROUP_PALETTE.length]!;
    const members =
      band.key === OTHER_WORK ? null : usageMemberBands(usage, band.key, metric, hourly);
    if (members !== null) memberSplits.set(band.key, members);
    return {
      key: band.key,
      label: band.key === OTHER_WORK ? OTHER_WORK_LABEL : band.key,
      named: band.key !== OTHER_WORK,
      color: palette?.color ?? OTHER_WORK_CSS,
      totalTokens: band.totalTokens,
      costUsd: band.costUsd,
      children: (members?.members ?? []).map((member, index) => ({
        key: member.key,
        label: member.name,
        named: true,
        // Members past the palette's three repeat its hues; the group's members are few.
        color: palette?.members[index % palette.members.length] ?? OTHER_WORK_CSS,
        totalTokens: member.totalTokens,
        costUsd: member.costUsd,
      })),
      hidden: new Set(
        (members?.members ?? []).flatMap((member) => (member.hidden === true ? [member.key] : [])),
      ),
    };
  });
  return {
    kind: "work",
    groups,
    spread: split.spread,
    valueAt: (period, key, by) => {
      if (split.bands.some((band) => band.key === key)) return split.valueAt(period, key, by);
      for (const members of memberSplits.values()) {
        if (members.members.some((member) => member.key === key)) {
          return members.valueAt(period, key, by);
        }
      }
      return 0;
    },
  };
}

/** The type box: tokens by token type, or cost by priced category. */
export function typeBox(usage: MergedUsage, metric: "cost" | "tokens", hourly: boolean): BoxModel {
  const split = usageSplitBands(usage, "type", metric, hourly);
  const groups = TYPES.map((type) => {
    const band = split.bands.find((entry) => entry.key === type.key);
    return leaf({
      ...type,
      named: false,
      totalTokens: band?.totalTokens ?? 0,
      costUsd: band?.costUsd ?? 0,
    });
  }).filter((group) => value(group, metric) > 0);
  return { kind: "type", groups, valueAt: split.valueAt };
}

/** The provider box: one row per provider, ranked as the page ranks them. */
export function providerBox(
  providers: readonly {
    readonly provider: UsageProviderKind;
    readonly label: string;
    readonly color: string;
    readonly totalTokens: number;
    readonly costUsd: number;
  }[],
  valueAt: BoxModel["valueAt"],
): BoxModel {
  return {
    kind: "provider",
    groups: providers.map(({ provider, ...band }) => leaf({ key: provider, named: true, ...band })),
    valueAt,
  };
}

/** Whether a parent opens: it has a child with a row of its own. */
export const opensIntoChildren = (group: BoxGroup) =>
  group.children.some((child) => !group.hidden.has(child.key));

/**
 * What the chart draws for a box, top band first as the card lists them: every row, with each
 * opened parent replaced by all of its children, hidden ones included.
 */
export function chartBands(box: BoxModel, open: ReadonlySet<string>): readonly BoxBand[] {
  return box.groups.flatMap((group) =>
    open.has(group.key) && opensIntoChildren(group) ? group.children : [group],
  );
}
