import type { UsageProcessBand, UsageProviderKind } from "@t3tools/contracts";
import {
  DEVICE_SPLIT_COLORS,
  OTHER_WORK_COLOR,
  PROCESS_SPLIT_COLORS,
  WORK_GROUP_PALETTE,
  darkLightness,
  usageSplitColorOfHex,
  type UsageSplitColor,
} from "@t3tools/client-runtime/usage-split-palette";
import {
  OTHER_WORK,
  usageMemberBands,
  usageSplitBands,
  type MergedDeviceBand,
  type MergedUsage,
  type SplitAmount,
  type UsageTypeBand,
} from "@t3tools/shared/usageMerge";
import { msg } from "gt-react";

/** The breakdown boxes beside the Usage chart, in page order; the open one is the chart's split. */
export type UsageBreakdown = "provider" | "device" | "process" | "work" | "type";
export const BREAKDOWN_ORDER: readonly UsageBreakdown[] = [
  "provider",
  "work",
  "device",
  "process",
  "type",
];

export const BREAKDOWN_TITLES = {
  tokens: {
    provider: msg("Tokens by provider"),
    device: msg("Tokens by device"),
    process: msg("Tokens by process"),
    work: msg("Tokens by kind of work"),
    type: msg("Tokens by direction"),
  },
  cost: {
    provider: msg("Cost by provider"),
    device: msg("Cost by device"),
    process: msg("Cost by process"),
    work: msg("Cost by kind of work"),
    type: msg("Cost by direction"),
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
  readonly children: readonly BoxBand[];
}

export interface BoxModel {
  readonly kind: UsageBreakdown;
  /** Rows in card order, largest first. A box with no group that has children is flat. */
  readonly groups: readonly BoxGroup[];
  /** A group's or child's value in one day or hour; keys as the groups and children carry them. */
  readonly valueAt: (period: string, key: string, metric: "cost" | "tokens") => number;
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;
const css = (color: UsageSplitColor) =>
  "ink" in color
    ? ink(color.ink)
    : `light-dark(oklch(${color.lightness} ${color.chroma} ${color.hue}), oklch(${darkLightness(color.lightness)} ${color.chroma} ${color.hue}))`;

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
    label: msg("Direct", { $context: "usage process: usage that is neither journal nor routine" }),
    color: css(PROCESS_SPLIT_COLORS.other),
  },
];

const GROUP_PALETTE = WORK_GROUP_PALETTE.map((group) => ({
  color: css(group.color),
  members: group.members.map(css),
}));
const OTHER_WORK_CSS = css(OTHER_WORK_COLOR);

export const OTHER_WORK_LABEL = msg("Other", { $context: "usage kind of work: usage in no group" });

// Greys from usageBreakdown.ts. What goes in opens into its token types; cost no category accounts
// for is Other.
const INPUT_TYPES: readonly { key: UsageTypeBand; label: string; color: string }[] = [
  { key: "cacheRead", label: msg("Cache read"), color: ink(30) },
  { key: "cacheWrite", label: msg("Cache write"), color: ink(72) },
  {
    key: "input",
    label: msg("Uncached", { $context: "usage input tokens not read from cache" }),
    color: ink(60),
  },
];
const INPUT = { key: "in", label: msg("Input"), color: ink(44) };
const OUTPUT = { key: "output", label: msg("Output"), color: ink(100) };
const OTHER_TYPE = { key: "other", label: msg("Other"), color: ink(20) };

const value = (band: { totalTokens: number; costUsd: number }, metric: "cost" | "tokens") =>
  metric === "cost" ? band.costUsd : band.totalTokens;

const leaf = (band: BoxBand): BoxGroup => ({ ...band, children: [] });

/** The members a kind of work hides, folded into one Others row: their key's prefix. */
const OTHERS_PREFIX = "others:";
const OTHERS_LABEL = msg("Others", { $context: "usage kind of work: its members without a row" });

/**
 * A kind of work's member rows: the members it shows, and the rest summed into one Others row.
 * A group that shows none opens into nothing, and stays one row.
 */
export function foldMembers<M extends { readonly hidden?: boolean | undefined } & SplitAmount>(
  members: readonly M[],
): { readonly shown: readonly M[]; readonly others: SplitAmount | null } {
  const shown = members.filter((member) => member.hidden !== true);
  const folded = members.filter((member) => member.hidden === true);
  const others = {
    totalTokens: folded.reduce((sum, member) => sum + member.totalTokens, 0),
    costUsd: folded.reduce((sum, member) => sum + member.costUsd, 0),
  };
  return {
    shown: shown.length === 0 ? [] : shown,
    others: shown.length === 0 || folded.length === 0 ? null : others,
  };
}

/** Largest first by the metric, rows and each parent's children alike; ties keep their order. */
function largestFirst(groups: readonly BoxGroup[], metric: "cost" | "tokens"): BoxGroup[] {
  const ranked = <B extends BoxBand>(bands: readonly B[]) =>
    bands.toSorted((a, b) => value(b, metric) - value(a, metric));
  return ranked(groups).map((group) => ({ ...group, children: ranked(group.children) }));
}

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
    };
  }).filter((group) => group.totalTokens > 0 || group.costUsd > 0);
  const childrenOf = new Map<string, readonly string[]>(
    DEVICE_GROUPS.map((group) => [group.key, group.children.map((child) => child.key)]),
  );
  return {
    kind: "device",
    groups: largestFirst(groups, metric),
    valueAt: (period, key, by) => {
      const children = childrenOf.get(key);
      return children === undefined
        ? split.valueAt(period, key, by)
        : children.reduce((sum, child) => sum + split.valueAt(period, child, by), 0);
    },
  };
}

/** The process box: journal, routines and direct. */
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
  return { kind: "process", groups: largestFirst(groups, metric), valueAt: split.valueAt };
}

/**
 * The kind-of-work box: groups, Other among them, each opening into the members its settings show
 * and one Others row for the rest.
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
    const folded = foldMembers(members?.members ?? []);
    return {
      key: band.key,
      label: band.key === OTHER_WORK ? OTHER_WORK_LABEL : band.key,
      named: band.key !== OTHER_WORK,
      color: palette?.color ?? OTHER_WORK_CSS,
      totalTokens: band.totalTokens,
      costUsd: band.costUsd,
      children: [
        ...folded.shown.map((member, index) => ({
          key: member.key,
          label: member.name,
          named: true,
          // Members past the palette's three repeat its hues; the group's members are few.
          color:
            member.color === undefined
              ? (palette?.members[index % palette.members.length] ?? OTHER_WORK_CSS)
              : css(usageSplitColorOfHex(member.color)),
          totalTokens: member.totalTokens,
          costUsd: member.costUsd,
        })),
        ...(folded.others === null
          ? []
          : [
              {
                key: `${OTHERS_PREFIX}${band.key}`,
                label: OTHERS_LABEL,
                named: false,
                color: OTHER_WORK_CSS,
                ...folded.others,
              },
            ]),
      ],
    };
  });
  return {
    kind: "work",
    groups: largestFirst(groups, metric),
    valueAt: (period, key, by) => {
      if (split.bands.some((band) => band.key === key)) return split.valueAt(period, key, by);
      if (key.startsWith(OTHERS_PREFIX)) {
        const members = memberSplits.get(key.slice(OTHERS_PREFIX.length));
        return (members?.members ?? [])
          .filter((member) => member.hidden === true)
          .reduce((sum, member) => sum + (members?.valueAt(period, member.key, by) ?? 0), 0);
      }
      for (const members of memberSplits.values()) {
        if (members.members.some((member) => member.key === key)) {
          return members.valueAt(period, key, by);
        }
      }
      return 0;
    },
  };
}

/**
 * The direction box: what goes in, opening into its token types, and output; cost no priced
 * category accounts for is Other.
 */
export function typeBox(usage: MergedUsage, metric: "cost" | "tokens", hourly: boolean): BoxModel {
  const split = usageSplitBands(usage, "type", metric, hourly);
  const amountOf = (key: string) => {
    const band = split.bands.find((entry) => entry.key === key);
    return { totalTokens: band?.totalTokens ?? 0, costUsd: band?.costUsd ?? 0 };
  };
  const children = INPUT_TYPES.map((type) => ({
    ...type,
    named: false,
    ...amountOf(type.key),
  })).filter((child) => value(child, metric) > 0);
  const input: BoxGroup = {
    ...INPUT,
    named: false,
    totalTokens: children.reduce((sum, child) => sum + child.totalTokens, 0),
    costUsd: children.reduce((sum, child) => sum + child.costUsd, 0),
    children,
  };
  const groups = [
    input,
    leaf({ ...OUTPUT, named: false, ...amountOf(OUTPUT.key) }),
    leaf({ ...OTHER_TYPE, named: false, ...amountOf(OTHER_TYPE.key) }),
  ].filter((group) => value(group, metric) > 0);
  const inputKeys = INPUT_TYPES.map((type) => type.key);
  return {
    kind: "type",
    groups: largestFirst(groups, metric),
    valueAt: (period, key, by) =>
      key === INPUT.key
        ? inputKeys.reduce((sum, child) => sum + split.valueAt(period, child, by), 0)
        : split.valueAt(period, key, by),
  };
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

/** Whether a parent opens: it has children of its own. */
export const opensIntoChildren = (group: BoxGroup) => group.children.length > 0;

/**
 * What the chart draws for a box, top band first as the card lists them: every row, with each
 * opened parent replaced by its children.
 */
export function chartBands(box: BoxModel, open: ReadonlySet<string>): readonly BoxBand[] {
  return box.groups.flatMap((group) =>
    open.has(group.key) && opensIntoChildren(group) ? group.children : [group],
  );
}
