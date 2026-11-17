/** The faintest a figure gets: its text colour at this share of full strength. */
const EMPHASIS_FLOOR = 0.7;
/** Figures this far up the scale stand as a league of their own. */
const TOP_LEAGUE_FROM = 0.8;

/**
 * Where each figure sits between the smallest (0) and the largest (1), by order of magnitude, so
 * billions stand apart from millions. The scale never spans less than one order of magnitude:
 * figures of similar size all stay near 1 rather than being stretched across it.
 */
export function emphasisPositions(values: readonly number[]): readonly number[] {
  const magnitudes = values.map((value) => (value > 0 ? Math.log10(value) : null));
  const known = magnitudes.filter((magnitude) => magnitude !== null);
  if (known.length === 0) return values.map(() => 1);
  const largest = Math.max(...known);
  const span = Math.max(largest - Math.min(...known), 1);
  return magnitudes.map((magnitude) => (magnitude === null ? 0 : 1 - (largest - magnitude) / span));
}

/** A text colour, not an opacity: the page already dims loading figures with opacity. */
export function emphasisColor(position: number): string {
  const strength = EMPHASIS_FLOOR + (1 - EMPHASIS_FLOOR) * position;
  return `color-mix(in oklab, var(--foreground) ${Math.round(strength * 100)}%, var(--background))`;
}

export function isTopLeague(position: number): boolean {
  return position >= TOP_LEAGUE_FROM;
}
