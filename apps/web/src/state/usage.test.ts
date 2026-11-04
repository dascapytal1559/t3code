import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeSelectedUsage, type EnvironmentUsageStatus } from "./usage";

const NONE: ReadonlySet<UsageProviderKind> = new Set();

function bucket(provider: UsageProviderKind, costUsd: number, outputTokens: number): UsageBucket {
  return {
    day: "2026-11-01",
    hourStart: "2026-11-01T10:00:00.000Z",
    provider,
    model: `${provider}-model`,
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens,
      reasoningTokens: 0,
    },
    records: 1,
    sessions: 1,
    costUsd,
    costSource: "modelPriced",
    unpricedRecords: 0,
    cacheSavingsUsd: costUsd / 2,
    categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: costUsd },
  } as UsageBucket;
}

function source(provider: UsageProviderKind, distinctSessions: number) {
  return {
    fingerprint: {
      hostId: "host-a",
      provider,
      resolvedHomePath: `/data/${provider}`,
      volumeId: "volume-a",
    },
    status: "ok",
    distinctSessions,
  };
}

const environment = {
  environmentId: EnvironmentId.make("environment-a"),
  label: "Environment A",
  isPending: false,
  canReadDiagnostics: true,
  isConnected: true,
  error: null,
  needsCursorKeychainAccess: false,
  summary: {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-11-01T12:00:00.000Z",
    buckets: [bucket("claude", 30, 300), bucket("codex", 10, 100), bucket("grok", 10, 100)],
    sources: [source("claude", 3), source("codex", 2), source("grok", 1)],
  } as unknown as UsageSummary,
} satisfies EnvironmentUsageStatus;

describe("mergeSelectedUsage", () => {
  it("lists nothing as excluded while every provider counts", () => {
    const usage = mergeSelectedUsage([environment], NONE);

    expect(usage.costUsd).toBe(50);
    expect(usage.excludedProviders).toEqual([]);
  });

  it("drops a hidden provider from every figure but keeps its own totals aside", () => {
    const usage = mergeSelectedUsage([environment], new Set<UsageProviderKind>(["claude"]));

    expect(usage.costUsd).toBe(20);
    expect(usage.totalTokens).toBe(200);
    expect(usage.sessions).toBe(3);
    expect(usage.costQuality.cacheSavingsUsd).toBe(10);
    expect(usage.categoryCost.output).toBe(20);
    expect(usage.models.map(({ model }) => model).toSorted()).toEqual([
      "codex-model",
      "grok-model",
    ]);
    expect(
      usage.providers
        .map(({ provider, costShare, tokenShare }) => [provider, costShare, tokenShare])
        .toSorted(),
    ).toEqual([
      ["codex", 0.5, 0.5],
      ["grok", 0.5, 0.5],
    ]);
    for (const period of [...usage.daily, ...usage.hourly]) {
      expect(period.costUsd).toBe(20);
      expect(period.byProvider.has("claude")).toBe(false);
    }

    expect(usage.excludedProviders).toEqual([
      expect.objectContaining({ provider: "claude", costUsd: 30, totalTokens: 300, sessions: 3 }),
    ]);
  });

  it("leaves nothing to chart when every provider is hidden", () => {
    const usage = mergeSelectedUsage(
      [environment],
      new Set<UsageProviderKind>(["claude", "codex", "grok"]),
    );

    expect(usage.costUsd).toBe(0);
    expect(usage.providers).toEqual([]);
    expect(usage.daily).toEqual([]);
    expect(usage.excludedProviders.map(({ provider }) => provider).toSorted()).toEqual([
      "claude",
      "codex",
      "grok",
    ]);
  });
});
