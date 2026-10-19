import type { UsageProviderKind, UsageSummary } from "@t3tools/contracts";

export interface ArchivedUsageRow {
  readonly host: string;
  readonly instance: string;
  readonly costUsd: number;
  readonly totalTokens: number;
}

/**
 * Fork feature: the part of the shown totals that comes from archived usage,
 * one row per archived host and instance. A source reported by several
 * environments counts once, as it does in the merged totals.
 */
export function archivedUsageRows(
  summaries: readonly UsageSummary[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): readonly ArchivedUsageRow[] {
  const rows = new Map<string, { -readonly [K in keyof ArchivedUsageRow]: ArchivedUsageRow[K] }>();
  const counted = new Set<string>();
  for (const summary of summaries) {
    for (const source of summary.sources) {
      const { archive, fingerprint } = source;
      if (archive === undefined || hiddenProviders.has(fingerprint.provider)) continue;
      const sourceKey = [
        fingerprint.hostId,
        fingerprint.provider,
        fingerprint.resolvedHomePath,
        fingerprint.volumeId,
      ].join("\u0000");
      if (counted.has(sourceKey)) continue;
      counted.add(sourceKey);
      const rowKey = `${archive.host}\u0000${archive.instance}`;
      const row = rows.get(rowKey) ?? { ...archive, costUsd: 0, totalTokens: 0 };
      for (const bucket of summary.buckets) {
        if (
          bucket.provider !== fingerprint.provider ||
          bucket.sourcePath !== fingerprint.resolvedHomePath
        ) {
          continue;
        }
        row.costUsd += bucket.costUsd;
        // reasoningTokens is a subset of outputTokens and must not be added again.
        row.totalTokens +=
          bucket.totals.uncachedInputTokens +
          bucket.totals.cachedInputTokens +
          bucket.totals.cacheCreationTokens +
          bucket.totals.outputTokens;
      }
      rows.set(rowKey, row);
    }
  }
  return [...rows.values()].filter((row) => row.totalTokens > 0);
}
