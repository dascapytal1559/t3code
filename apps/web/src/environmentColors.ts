import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";

// Fork: Remote host on thread cards (FORK_FEATURES.md). Every remote
// environment gets a color so its machine glyph tells rows on different hosts
// apart without a label. Colors are dealt in catalog order, so a host keeps
// its color as long as the remotes added before it stay; the sequence starts
// with the hues that are farthest apart and wraps once it runs out.
export const REMOTE_ENVIRONMENT_COLOR_SEQUENCE: ReadonlyArray<ProjectIconColor> = [
  "blue",
  "orange",
  "emerald",
  "violet",
  "rose",
  "amber",
  "cyan",
  "fuchsia",
  "lime",
  "indigo",
  "teal",
  "red",
];

export function assignRemoteEnvironmentColors(
  remoteEnvironmentIds: Iterable<EnvironmentId>,
): ReadonlyMap<EnvironmentId, ProjectIconColor> {
  const colorById = new Map<EnvironmentId, ProjectIconColor>();
  for (const environmentId of remoteEnvironmentIds) {
    if (colorById.has(environmentId)) continue;
    const color =
      REMOTE_ENVIRONMENT_COLOR_SEQUENCE[colorById.size % REMOTE_ENVIRONMENT_COLOR_SEQUENCE.length];
    if (color === undefined) continue;
    colorById.set(environmentId, color);
  }
  return colorById;
}
