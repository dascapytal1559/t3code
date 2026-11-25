import type { UsageDeviceBand, UsageProcessBand } from "@t3tools/contracts";

/**
 * A Usage split colour: an oklch hue in light mode (dark mode is a little lighter, as every split
 * colour is), or a grey that is `ink` percent of the foreground over the background.
 */
export type UsageSplitColor =
  | { readonly lightness: number; readonly chroma: number; readonly hue: number }
  | { readonly ink: number };

const hue = (hue: number, lightness: number, chroma: number): UsageSplitColor => ({
  lightness,
  chroma,
  hue,
});

export const darkLightness = (lightness: number) => Math.min(0.9, lightness + 0.08);

// A parent owns one colour; its children take neighbouring hues, so they read as relatives that
// are clearly different. Phone is amber and computer blue.
export const DEVICE_SPLIT_COLORS = {
  phone: hue(66, 0.74, 0.145),
  phoneOrchestrated: hue(42, 0.68, 0.17),
  phoneDirect: hue(92, 0.78, 0.15),
  computer: hue(264, 0.58, 0.17),
  computerDirect: hue(236, 0.62, 0.14),
  computerOrchestrated: hue(290, 0.52, 0.19),
  unlabelled: { ink: 28 },
} as const satisfies Record<UsageDeviceBand | "phone" | "computer", UsageSplitColor>;

// Journal is a rose, routines a green, incidents a blue and direct (shown for `other`) an amber,
// well apart.
export const PROCESS_SPLIT_COLORS = {
  journal: hue(355, 0.62, 0.16),
  routines: hue(160, 0.6, 0.11),
  incident: hue(250, 0.58, 0.15),
  other: hue(80, 0.76, 0.14),
} as const satisfies Record<UsageProcessBand, UsageSplitColor>;

export interface WorkGroupColors {
  readonly color: UsageSplitColor;
  readonly members: readonly UsageSplitColor[];
}

// Kinds of work without their own colour take these in settings order, with their members in the
// neighbouring hues. The first two are a warm stone and a crimson; none reuses the device colours'
// orange and blue.
export const WORK_GROUP_PALETTE: readonly WorkGroupColors[] = [
  {
    color: hue(60, 0.6, 0.02),
    members: [hue(70, 0.48, 0.035), hue(100, 0.68, 0.045), hue(60, 0.74, 0.02)],
  },
  {
    color: hue(15, 0.52, 0.17),
    members: [hue(358, 0.46, 0.16), hue(30, 0.62, 0.15), hue(10, 0.7, 0.1)],
  },
  {
    color: hue(150, 0.62, 0.08),
    members: [hue(138, 0.54, 0.11), hue(165, 0.68, 0.1), hue(150, 0.74, 0.06)],
  },
  {
    color: hue(330, 0.5, 0.13),
    members: [hue(318, 0.44, 0.14), hue(345, 0.6, 0.13), hue(330, 0.7, 0.08)],
  },
  {
    color: hue(185, 0.6, 0.1),
    members: [hue(170, 0.52, 0.12), hue(196, 0.7, 0.1), hue(185, 0.76, 0.07)],
  },
  {
    color: hue(115, 0.6, 0.1),
    members: [hue(108, 0.5, 0.12), hue(132, 0.68, 0.11), hue(118, 0.76, 0.07)],
  },
];

export const OTHER_WORK_COLOR: UsageSplitColor = { ink: 36 };

// A group's own colour gives its members shades as the palette's do: a darker, stronger one a
// little cooler, a lighter one a little warmer, and a pale one of the same hue.
const memberShadesOf = (group: UsageSplitColor): readonly UsageSplitColor[] => {
  if ("ink" in group) return [group];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const shade = (turn: number, lighter: number, strength: number) =>
    hue(
      round((group.hue + turn + 360) % 360),
      round(Math.min(0.9, Math.max(0.2, group.lightness + lighter))),
      round(group.chroma * strength),
    );
  return [shade(-13, -0.08, 1.15), shade(13, 0.08, 1), shade(0, 0.15, 0.65)];
};

/**
 * A kind of work's colours: its own `#rrggbb` colour when settings give it one, with member shades
 * derived from it, else the palette's entry for its place in the settings order.
 */
export function workGroupColors(groupIndex: number, color: string | undefined): WorkGroupColors {
  if (color === undefined) return WORK_GROUP_PALETTE[groupIndex % WORK_GROUP_PALETTE.length]!;
  const own = usageSplitColorOfHex(color);
  return { color: own, members: memberShadesOf(own) };
}

type Lab = readonly [number, number, number];

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const fromLinear = (channel: number) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

function hexToOklab(hex: string): Lab {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = toLinear((value >> 16) / 255);
  const g = toLinear(((value >> 8) & 255) / 255);
  const b = toLinear((value & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// Out-of-gamut channels are clipped; these colours are mild enough that browsers barely differ.
function oklabToHex([lightness, a, b]: Lab): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return `#${[
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, fromLinear(channel))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** A member's own `#rrggbb` colour as a split colour, so dark mode lightens it as it does the rest. */
export function usageSplitColorOfHex(hex: string): UsageSplitColor {
  const [lightness, a, b] = hexToOklab(hex);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    lightness: round(lightness),
    chroma: round(Math.hypot(a, b)),
    hue: round(((Math.atan2(b, a) * 180) / Math.PI + 360) % 360),
  };
}

/** A split colour as `#rrggbb`, for clients that cannot draw oklch; greys mix in oklab as CSS does. */
export function usageSplitHex(
  color: UsageSplitColor,
  dark: boolean,
  ground: { readonly foreground: string; readonly background: string },
): string {
  if ("ink" in color) {
    const foreground = hexToOklab(ground.foreground);
    const background = hexToOklab(ground.background);
    const share = color.ink / 100;
    const mix = (index: 0 | 1 | 2) => foreground[index] * share + background[index] * (1 - share);
    return oklabToHex([mix(0), mix(1), mix(2)]);
  }
  const lightness = dark ? darkLightness(color.lightness) : color.lightness;
  const radians = (color.hue * Math.PI) / 180;
  return oklabToHex([
    lightness,
    color.chroma * Math.cos(radians),
    color.chroma * Math.sin(radians),
  ]);
}
