import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  isModelCostUnknown,
  mergeUsage,
  usageMemberBands,
  usageSplitBands,
  type EnvironmentUsage,
} from "./usageMerge.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    physicalSourceId?: string;
    distinctSessions?: number;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
        ...(source.physicalSourceId === undefined
          ? {}
          : { physicalSourceId: source.physicalSourceId }),
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("counts a Cursor account once across servers while retaining each server's other providers", () => {
    const account = {
      provider: "cursor" as const,
      hostId: "cursor.com",
      homePath: "cursor-account:account-hash",
      volumeId: "account-hash",
    };
    const merged = mergeUsage(
      [
        environment(
          "mac",
          summary([bucket({ provider: "cursor", sourcePath: account.homePath })], [account]),
        ),
        environment(
          "linux",
          summary(
            [
              bucket({ provider: "cursor", sourcePath: account.homePath }),
              bucket({ provider: "opencode", sourcePath: "/opencode" }),
            ],
            [account, { provider: "opencode", hostId: "linux", homePath: "/opencode" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(
      merged.providers.map((provider) => [provider.provider, provider.costUsd]).sort(),
    ).toEqual([
      ["cursor", 10],
      ["opencode", 10],
    ]);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("counts a shared transcript directory once", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("counts overlapping provider roots once while keeping each environment's unique root", () => {
    const source = (homePath: string) => ({
      provider: "opencode" as const,
      hostId: "host",
      homePath,
    });
    const usage = (sourcePath: string, costUsd: number) =>
      bucket({ provider: "opencode", sourcePath, costUsd });
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([usage("/shared", 10), usage("/a", 2)], [source("/shared"), source("/a")]),
        ),
        environment(
          "env-b",
          summary([usage("/shared", 10), usage("/b", 3)], [source("/shared"), source("/b")]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.costUsd).toBe(15);
    expect(merged.sessions).toBe(3);
  });

  it("uses the newest scan when environments share the same transcript directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const environments = [
      environment("env-a", summary([bucket({ costUsd: 4, records: 2 })], [source])),
      environment("env-b", {
        ...summary([bucket()], [source]),
        readAt: "2026-08-07T01:00:00.000Z",
      }),
    ];

    for (const ordered of [environments, environments.toReversed()]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.records).toBe(5);
      expect(merged.sessions).toBe(1);
      expect(merged.contributingEnvironments).toEqual(["env-b"]);
      expect(merged.duplicateSources).toEqual(["env-a: /home/theo/.claude"]);
    }
  });

  it("prefers a complete scan over a newer partial scan of the same directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const incomplete = summary([bucket({ costUsd: 4, records: 2 })], [source]);
    const partial = environment("new", {
      ...incomplete,
      readAt: "2026-08-07T01:00:00.000Z",
      sources: incomplete.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });
    const complete = environment("old", summary([bucket()], [source]));

    for (const ordered of [
      [partial, complete],
      [complete, partial],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.contributingEnvironments).toEqual(["old"]);
      expect(merged.duplicateSources).toEqual(["new: /home/theo/.claude"]);
    }
    expect(mergeUsage([partial], USAGE_CONTRACT_VERSION).costUsd).toBe(4);
  });

  it("keeps new cells from a later partial scan without recounting older cells", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment(
      "old",
      summary([bucket()], [source], USAGE_MERGE_COMPATIBLE_SINCE),
    );
    const partialSummary = summary(
      [
        bucket({ sourcePath: source.homePath, costUsd: 4, records: 2 }),
        bucket({
          day: "2026-08-08" as UsageDay,
          sourcePath: source.homePath,
          costUsd: 3,
          records: 1,
        }),
      ],
      [{ ...source, distinctSessions: 2 }],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-08T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    for (const ordered of [
      [complete, partial],
      [partial, complete],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.records).toBe(6);
      expect(merged.sessions).toBe(2);
      expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
        ["2026-08-07", 10],
        ["2026-08-08", 3],
      ]);
      expect(merged.contributingEnvironments).toEqual(
        ordered.map(({ environmentId }) => environmentId),
      );
      expect(merged.duplicateSources).toEqual(["new: /home/theo/.claude"]);
    }

    const filtered = environment("new", {
      ...partial.summary,
      modelFilter: { exclude: [{ model: "claude-fable-5" }] },
    });
    const merged = mergeUsage([complete, filtered], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.sessions).toBe(1);
  });

  it("retains a complete cell when a larger partial cell may have skipped old records", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment("old", summary([bucket()], [source]));
    const partialSummary = summary(
      [
        bucket({
          costUsd: 4,
          records: 6,
          totals: {
            uncachedInputTokens: 80,
            cachedInputTokens: 500,
            cacheCreationTokens: 10,
            outputTokens: 30,
            reasoningTokens: 0,
          },
        }),
      ],
      [{ ...source, distinctSessions: 2 }],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-07T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    const merged = mergeUsage([complete, partial], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.contributingEnvironments).toEqual(["old"]);
  });

  it("identifies an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-b",
        direction: "serverBehind",
        contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1,
      },
    ]);
  });

  it("identifies an environment reporting a newer contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
            USAGE_CONTRACT_VERSION + 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(0);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-a",
        direction: "clientBehind",
        contractVersion: USAGE_CONTRACT_VERSION + 1,
      },
    ]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("keeps known usage when newer providers and bucket variants cannot be decoded", () => {
    const known = summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]);
    const decoded = decodeSummary({
      ...known,
      buckets: [
        ...known.buckets,
        { ...bucket(), provider: "future-provider", costUsd: 100 },
        { ...bucket(), costSource: "future-pricing", costUsd: 200 },
      ],
      sources: [
        ...known.sources,
        {
          ...known.sources[0],
          fingerprint: {
            ...known.sources[0]?.fingerprint,
            provider: "future-provider",
          },
        },
      ],
    });
    expect(decoded).toEqual(known);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("normalizes model names during decoding before grouping usage", () => {
    const decoded = decodeSummary(
      summary(
        [
          bucket({ provider: "codex", model: " gpt-5 " }),
          bucket({ provider: "codex", model: "gpt-5" }),
        ],
        [{ provider: "codex", hostId: "mac", homePath: "/a" }],
      ),
    );

    expect(decoded.buckets.map((entry) => entry.model)).toEqual(["gpt-5", "gpt-5"]);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0]).toMatchObject({ model: "gpt-5", costUsd: 20, totalTokens: 2320 });
  });

  it("marks a model with no known rates as unpriced rather than free", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.models.find((model) => model.model === "unknown-model")?.unpricedRecords).toBe(5);
    expect(merged.models.filter(isModelCostUnknown).map((model) => model.model)).toEqual([
      "unknown-model",
    ]);
  });

  it("splits cost by category and speed, counting older servers as unsplit standard cost", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({
                costUsd: 10,
                categoryCostUsd: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
                fastCostUsd: 6,
                speedPremiumUsd: 3,
              }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
              bucket({
                provider: "codex",
                model: "partly-reported",
                costUsd: 0,
                unpricedRecords: 4,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 5 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }],
            USAGE_MERGE_COMPATIBLE_SINCE,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.categoryCost).toEqual({
      input: 1,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4,
      unsplit: 5,
    });
    expect(merged.speedCost).toEqual({ standard: 9, fast: 6, ultrafast: 0, premium: 3 });
    // By type: tokens by token type, cost by category, cost no category accounts for as other.
    const types = usageSplitBands(merged, "type", "cost", false);
    expect(Object.fromEntries(types.bands.map((band) => [band.key, band.costUsd]))).toEqual({
      output: 4,
      cacheWrite: 3,
      cacheRead: 2,
      input: 1,
      other: 5,
    });
    const day = merged.daily[0]!;
    expect(
      types.bands.reduce((sum, band) => sum + types.valueAt(day.day, band.key, "tokens"), 0),
    ).toBe(day.totalTokens);
    expect(merged.models.map(({ model, unpricedTokens }) => [model, unpricedTokens])).toEqual([
      ["claude-fable-5", 0],
      ["unknown-model", 1160],
      ["partly-reported", 928],
    ]);
  });

  it("splits usage by device and kind of work so each day's bands add up to its total", () => {
    const mac = { provider: "claude" as const, hostId: "mac", homePath: "/a/.claude" };
    const day8 = "2026-08-08" as UsageDay;
    const withOrigins = (usageSummary: UsageSummary): UsageSummary => ({
      ...usageSummary,
      origins: { usage: [], prompts: [] },
    });
    const merged = mergeUsage(
      [
        environment(
          "mac",
          withOrigins({
            ...summary(
              [
                bucket({
                  sourcePath: mac.homePath,
                  devices: { phoneDirect: [800, 6], computerOrchestrated: [360, 4] },
                  work: { Tooling: [1000, 7], "": [160, 3] },
                }),
                // Parts rounded to a micro-dollar, and a part the server did not split.
                bucket({
                  sourcePath: mac.homePath,
                  model: "claude-opus-5-5",
                  costUsd: 3,
                  devices: { computerDirect: [1000, 2.0000004] },
                  work: "Trading",
                }),
                bucket({
                  day: day8,
                  sourcePath: mac.homePath,
                  devices: "computerDirect",
                  work: "Trading",
                }),
              ],
              [mac],
            ),
            workGroups: ["Trading", "Tooling", "Projects"],
            workMembers: [{ key: "folder:~/notes", group: "Trading", name: "notes" }],
          }),
        ),
        // The same directory read again counts once; an older server's buckets carry no split.
        environment("mac-again", {
          ...summary([bucket({ sourcePath: mac.homePath })], [mac]),
          workMembers: [{ key: "folder:~/notes", group: "Tooling", name: "notes" }],
        }),
        environment(
          "old",
          summary(
            [bucket({ day: day8, provider: "codex" })],
            [{ provider: "codex", hostId: "old", homePath: "/o/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    for (const day of merged.daily) {
      for (const split of [merged.devices!, merged.work]) {
        const bands = [...(split.daily.get(day.day)?.values() ?? [])];
        expect(bands.reduce((sum, band) => sum + band.totalTokens, 0)).toBe(day.totalTokens);
        expect(bands.reduce((sum, band) => sum + band.costUsd, 0)).toBeCloseTo(day.costUsd, 9);
      }
    }
    expect(Object.fromEntries(merged.devices!.daily.get("2026-08-07")!)).toEqual({
      phoneDirect: { totalTokens: 800, costUsd: 6 },
      computerOrchestrated: { totalTokens: 360, costUsd: 4 },
      computerDirect: { totalTokens: 1000, costUsd: expect.closeTo(2, 5) },
      unlabelled: { totalTokens: 160, costUsd: expect.closeTo(1, 5) },
    });
    expect(Object.fromEntries(merged.work.daily.get(day8)!)).toEqual({
      Trading: { totalTokens: 1160, costUsd: 10 },
      "": { totalTokens: 1160, costUsd: 10 },
    });
    expect(merged.workGroups).toEqual(["Trading", "Tooling", "Projects"]);
    // A folder entry two servers place differently keeps the first server's group.
    expect(merged.workMemberInfo).toEqual([
      { key: "folder:~/notes", group: "Trading", name: "notes" },
    ]);

    const bands = usageSplitBands(merged, "work", "cost", false);
    // Largest first, Other last; a group keeps its place in the servers' order for its colour.
    expect(bands.bands.map(({ key, groupIndex }) => [key, groupIndex])).toEqual([
      ["Trading", 0],
      ["Tooling", 1],
      ["", null],
    ]);
    expect(bands.valueAt("2026-08-07", "Tooling", "tokens")).toBe(1000);
    // Nothing is shared unless a server says so.
    expect(bands.spread).toEqual([]);
    expect(usageSplitBands(merged, "device", "tokens", false).bands.map(({ key }) => key)).toEqual([
      "computerDirect",
      "phoneDirect",
      "computerOrchestrated",
      "unlabelled",
    ]);
  });

  describe("shared kinds of work", () => {
    const mac = { provider: "claude" as const, hostId: "mac", homePath: "/a/.claude" };
    const day8 = "2026-08-08" as UsageDay;
    const shared = (buckets: readonly UsageBucket[]) =>
      mergeUsage(
        [
          environment("mac", {
            ...summary(buckets, [mac]),
            workGroups: ["Bones", "Meat", "Coordination"],
            sharedWork: ["Coordination", ""],
            workMembers: [
              { key: "t3", group: "Bones", name: "t3code-fork" },
              { key: "fm", group: "Bones", name: "firstmate", hidden: true },
              // A second project of the same repository: one row with the first.
              { key: "t3-mcp", group: "Bones", name: "t3code-fork", hidden: true },
            ],
          }),
        ],
        USAGE_CONTRACT_VERSION,
      );

    it("spreads shared groups and Other over the others by each day's own ratio, else the window's", () => {
      const merged = shared([
        bucket({
          sourcePath: mac.homePath,
          work: { Bones: [300, 2], Meat: [600, 6], Coordination: [200, 1], "": [60, 1] },
          workMembers: { t3: [150, 1], "t3-mcp": [50, 0.5], fm: [100, 0.5] },
        }),
        // A day with only shared usage takes the window's ratio.
        bucket({ day: day8, sourcePath: mac.homePath, work: "Coordination" }),
      ]);
      const split = usageSplitBands(merged, "work", "tokens", false);

      expect(split.bands.map((band) => band.key)).toEqual(["Meat", "Bones"]);
      expect(split.spread).toEqual(["Coordination", ""]);
      for (const day of merged.daily) {
        const bands = split.bands.map((band) => ({
          tokens: split.valueAt(day.day, band.key, "tokens"),
          cost: split.valueAt(day.day, band.key, "cost"),
        }));
        expect(bands.reduce((sum, band) => sum + band.tokens, 0)).toBeCloseTo(day.totalTokens, 6);
        expect(bands.reduce((sum, band) => sum + band.cost, 0)).toBeCloseTo(day.costUsd, 9);
        // Each measure keeps the ratio its own usage has: 300:600 tokens, $2:$6 cost.
        const ratio = (by: "tokens" | "cost") =>
          split.valueAt(day.day, "Bones", by) / split.valueAt(day.day, "Meat", by);
        expect(ratio("tokens")).toBeCloseTo(1 / 2, 9);
        expect(ratio("cost")).toBeCloseTo(1 / 3, 9);
      }
      expect(split.bands.reduce((sum, band) => sum + band.totalTokens, 0)).toBeCloseTo(
        merged.totalTokens,
        6,
      );

      // Bones' members add up to Bones as shown, shared usage included, each keeping its share;
      // the day with only shared usage splits by the members' window shares.
      const members = usageMemberBands(merged, "Bones", "tokens", false);
      expect(members.members.map((member) => [member.key, member.name, member.hidden])).toEqual([
        ["t3", "t3code-fork", undefined],
        ["fm", "firstmate", true],
      ]);
      for (const day of merged.daily) {
        for (const by of ["tokens", "cost"] as const) {
          const t3 = members.valueAt(day.day, "t3", by);
          const fm = members.valueAt(day.day, "fm", by);
          expect(t3 + fm).toBeCloseTo(split.valueAt(day.day, "Bones", by), 9);
          expect(t3 / fm).toBeCloseTo(by === "tokens" ? 2 : 3, 9);
        }
      }
      expect(usageMemberBands(merged, "Meat", "tokens", false).members).toEqual([]);
    });

    it("leaves shared usage in Other when no group in the window has any", () => {
      const split = usageSplitBands(
        shared([
          bucket({ sourcePath: mac.homePath, work: { Coordination: [1000, 9], "": [160, 1] } }),
        ]),
        "work",
        "cost",
        false,
      );

      expect(split.bands).toEqual([{ key: "", groupIndex: null, costUsd: 10, totalTokens: 1160 }]);
      expect(split.spread).toEqual([]);
    });
  });

  it("counts all usage as unlabelled when no server reports origins", () => {
    const merged = mergeUsage(
      [
        environment(
          "old",
          summary([bucket()], [{ provider: "claude", hostId: "old", homePath: "/o/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.devices).toBeNull();
    expect(usageSplitBands(merged, "device", "cost", false).bands).toEqual([
      { key: "unlabelled", groupIndex: null, costUsd: 10, totalTokens: 1160 },
    ]);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  describe("one directory seen from both sides of a Windows and WSL boundary", () => {
    // Fingerprints the reporter captured for one NTFS directory, read natively by
    // Windows and through the drvfs mount by WSL. Path and dev:ino both differ.
    const physicalSourceId = "physical-claude-projects";
    const windows = {
      provider: "claude" as const,
      hostId: "MainPC",
      homePath: "C:\\Users\\user\\.claude\\projects",
      volumeId: "1280555009:3659174697951285",
      physicalSourceId,
      distinctSessions: 142,
    };
    const wsl = {
      provider: "claude" as const,
      hostId: "MainPC",
      homePath: "/mnt/c/Users/user/.claude/projects",
      volumeId: "112:3659174697951287",
      physicalSourceId,
      distinctSessions: 142,
    };

    it("counts it once, whichever scan is newer", () => {
      const environments = [
        environment(
          "windows",
          summary([bucket({ sourcePath: windows.homePath, records: 22433 })], [windows]),
        ),
        environment("wsl", {
          ...summary([bucket({ sourcePath: wsl.homePath, records: 22432 })], [wsl]),
          readAt: "2026-08-07T00:05:00.000Z",
        }),
      ];

      for (const ordered of [environments, environments.toReversed()]) {
        const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
        expect(merged.sessions).toBe(142);
        expect(merged.records).toBe(22432);
        expect(merged.costUsd).toBe(10);
        expect(merged.contributingEnvironments).toEqual(["wsl"]);
        expect(merged.duplicateSources).toEqual([`windows: ${windows.homePath}`]);
      }
    });

    it("keeps only new cells from a later partial scan through the other side", () => {
      const complete = environment(
        "windows",
        summary([bucket({ sourcePath: windows.homePath })], [windows]),
      );
      const partialSummary = summary(
        [
          bucket({ sourcePath: wsl.homePath, costUsd: 4, records: 2 }),
          bucket({ day: "2026-08-08" as UsageDay, sourcePath: wsl.homePath, costUsd: 3 }),
        ],
        [{ ...wsl, distinctSessions: 143 }],
      );
      const partial = environment("wsl", {
        ...partialSummary,
        readAt: "2026-08-08T01:00:00.000Z",
        sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
      });

      const merged = mergeUsage([complete, partial], USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.sessions).toBe(143);
      expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
        ["2026-08-07", 10],
        ["2026-08-08", 3],
      ]);
    });

    it("counts it once when one server reaches it through two mounts", () => {
      const secondMount = { ...wsl, homePath: "/mnt/win/Users/user/.claude/projects" };
      const merged = mergeUsage(
        [
          environment(
            "wsl",
            summary(
              [
                bucket({ sourcePath: wsl.homePath }),
                bucket({
                  day: "2026-08-08" as UsageDay,
                  sourcePath: secondMount.homePath,
                  costUsd: 3,
                }),
              ],
              [wsl, secondMount],
            ),
          ),
        ],
        USAGE_CONTRACT_VERSION,
      );

      expect(merged.costUsd).toBe(10);
      expect(merged.sessions).toBe(142);
      expect(merged.daily.map(({ day }) => day)).toEqual(["2026-08-07"]);
      expect(merged.duplicateSources).toEqual([`wsl: ${secondMount.homePath}`]);
    });

    it("still counts a shared directory once when only one server reports physical identity", () => {
      const { physicalSourceId: _omitted, ...legacy } = windows;
      const merged = mergeUsage(
        [
          environment("desktop", summary([bucket({ sourcePath: windows.homePath })], [windows])),
          environment("standalone", summary([bucket({ sourcePath: legacy.homePath })], [legacy])),
        ],
        USAGE_CONTRACT_VERSION,
      );

      expect(merged.costUsd).toBe(10);
      expect(merged.sessions).toBe(142);
      expect(merged.duplicateSources).toHaveLength(1);
    });

    it("counts it once when two desktop installs with different scopes read it", () => {
      const merged = mergeUsage(
        [
          environment("packaged", summary([bucket({ sourcePath: windows.homePath })], [windows])),
          environment(
            "dev-build",
            summary(
              [bucket({ sourcePath: windows.homePath })],
              [{ ...windows, physicalSourceId: "physical-other-scope" }],
            ),
          ),
        ],
        USAGE_CONTRACT_VERSION,
      );

      expect(merged.costUsd).toBe(10);
      expect(merged.sessions).toBe(142);
      expect(merged.duplicateSources).toHaveLength(1);
    });
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("counts origin usage once per owned source, sums prompts, and leaves the rest unlinked", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/mac/.claude" };
    const phoneRow = {
      origin: "phone" as const,
      basis: "stamp" as const,
      provider: "claude" as const,
      sourcePath: shared.homePath,
      totals: { ...bucket().totals, uncachedInputTokens: 40, cachedInputTokens: 0 },
      costUsd: 4,
    };
    const withOrigins = (
      usageSummary: UsageSummary,
      origins: NonNullable<UsageSummary["origins"]>,
    ): UsageSummary => ({ ...usageSummary, origins });
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          withOrigins(summary([bucket({ sourcePath: shared.homePath })], [shared]), {
            usage: [phoneRow],
            prompts: [
              { origin: "phone", basis: "stamp", prompts: 2 },
              { origin: "phone", basis: "nativeApp", prompts: 3 },
              // A crew prompt whose cause leads to a phone prompt keeps its sender apart.
              { origin: "phone", basis: "stamp", via: "crew", prompts: 1 },
            ],
          }),
        ),
        // Reads the same directory, so its origin usage is env-a's, but its prompts are its own.
        environment(
          "env-b",
          withOrigins(summary([bucket({ sourcePath: shared.homePath })], [shared]), {
            usage: [phoneRow],
            prompts: [{ origin: "unknown", basis: "unstamped", prompts: 7 }],
          }),
        ),
        // Predates origins: all of its usage is unlinked.
        environment(
          "env-old",
          summary(
            [bucket({ provider: "codex", sourcePath: "/old/.codex" })],
            [{ provider: "codex", hostId: "old", homePath: "/old/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.origins).toEqual({
      rows: [
        {
          origin: "phone",
          prompts: 6,
          costUsd: 4,
          totalTokens: 100,
          bases: [
            { basis: "nativeApp", prompts: 3, costUsd: 0, totalTokens: 0 },
            { basis: "stamp", prompts: 2, costUsd: 4, totalTokens: 100 },
            { basis: "stamp", via: "crew", prompts: 1, costUsd: 0, totalTokens: 0 },
          ],
        },
        {
          origin: "unknown",
          prompts: 7,
          costUsd: 0,
          totalTokens: 0,
          bases: [{ basis: "unstamped", prompts: 7, costUsd: 0, totalTokens: 0 }],
        },
      ],
      unlinkedCostUsd: 16,
      unlinkedTokens: merged.totalTokens - 100,
    });
    expect(
      mergeUsage([environment("env-old", summary([bucket()], [shared]))], USAGE_CONTRACT_VERSION)
        .origins,
    ).toBeNull();
  });
});
