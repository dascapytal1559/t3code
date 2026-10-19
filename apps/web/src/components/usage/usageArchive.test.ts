import type { UsageBucket, UsageSource, UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { archivedUsageRows } from "./usageArchive";

const source = (path: string, archive?: UsageSource["archive"]): UsageSource => ({
  fingerprint: {
    hostId: archive?.host ?? "laptop",
    provider: "claude",
    resolvedHomePath: path,
    volumeId: "1:2",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
  ...(archive ? { archive } : {}),
});

const bucket = (sourcePath: string, outputTokens: number, costUsd: number): UsageBucket =>
  ({
    day: "2026-08-01",
    provider: "claude",
    model: "claude-fable-5",
    sourcePath,
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  }) as UsageBucket;

const summary = (sources: UsageSource[], buckets: UsageBucket[]) =>
  ({ sources, buckets }) as unknown as UsageSummary;

describe("archivedUsageRows", () => {
  it("totals archived sources per host and instance, once per source", () => {
    const remote = { host: "remote-a", instance: "home/.claude" };
    const archived = summary(
      [
        source("/live"),
        source("/archive/remote-a/home/.claude/projects", remote),
        source("/archive/remote-a/home/.t3/userdata", { host: "remote-a", instance: "home/.t3" }),
      ],
      [
        bucket("/live", 100, 1),
        bucket("/archive/remote-a/home/.claude/projects", 20, 0.2),
        bucket("/archive/remote-a/home/.t3/userdata", 0, 0),
      ],
    );
    // Another environment on the same machine reads the same archive.
    const twin = summary(
      [source("/archive/remote-a/home/.claude/projects", remote)],
      [bucket("/archive/remote-a/home/.claude/projects", 20, 0.2)],
    );

    expect(archivedUsageRows([archived, twin], new Set())).toEqual([
      { host: "remote-a", instance: "home/.claude", costUsd: 0.2, totalTokens: 20 },
    ]);
    expect(archivedUsageRows([archived], new Set(["claude"]))).toEqual([]);
  });
});
