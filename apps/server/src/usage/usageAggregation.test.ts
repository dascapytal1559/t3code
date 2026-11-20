import { describe, expect, it } from "@effect/vitest";

import {
  type CountedRecord,
  resolveModelAliases,
  toUsageExportRecord,
  UsageAggregator,
} from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      cacheCreation1hCostPerToken: 2e-5,
      fast: {
        inputCostPerToken: 2e-5,
        outputCostPerToken: 1e-4,
        cacheReadCostPerToken: 2e-6,
        cacheCreationCostPerToken: 2.5e-5,
        cacheCreation1hCostPerToken: 4e-5,
      },
      ultrafast: null,
      contextTiers: [],
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("splits a bucket's cost by category and speed", () => {
    const [bucket] = aggregate([record(), record({ speed: "fast" })]).buckets;

    expect(bucket).toMatchObject({
      costUsd: expect.closeTo(0.016875),
      categoryCostUsd: {
        input: expect.closeTo(0.003),
        cacheRead: expect.closeTo(0.003),
        cacheWrite: expect.closeTo(0.000375),
        output: expect.closeTo(0.0075),
      },
      fastCostUsd: expect.closeTo(0.01125),
      speedPremiumUsd: expect.closeTo(0.005625),
    });
    expect(bucket).not.toHaveProperty("ultrafastCostUsd");
  });

  it("merges partial copies of a key by channel maximum in the first copy's bucket", () => {
    const zeroTotals = {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    const partial = record({
      dedupeKey: "msg_1:",
      speed: "fast",
      reportedCostUsd: 1,
      totals: { ...record().totals, cachedInputTokens: 1200, outputTokens: 3, reasoningTokens: 5 },
    });
    const complete = record({
      dedupeKey: "msg_1:",
      model: "claude-fable-5[1m]",
      timestampMs: Date.parse("2026-08-08T12:00:00Z"),
      sessionId: "session-fork",
      reportedCostUsd: 2,
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 1000,
        cacheCreationTokens: 40,
        outputTokens: 264,
        reasoningTokens: 135,
      },
    });
    const zero = { ...partial, totals: zeroTotals, reportedCostUsd: null };
    const merged = {
      reportedCostUsd: 2,
      totals: { ...complete.totals, uncachedInputTokens: 100, cachedInputTokens: 1200 },
    };

    for (const copies of [
      [zero, partial, complete, complete],
      [complete, partial, zero, zero],
    ]) {
      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-31",
        rates,
      });
      copies.forEach((copy, index) => aggregator.add(copy, `${index}.jsonl`));
      const result = aggregator.finish();
      const expected = aggregate([{ ...copies[0]!, ...merged }]).buckets[0];

      expect(result.duplicatesDropped).toBe(3);
      expect(result.buckets).toEqual([{ ...expected, sourcePath: "0.jsonl" }]);
    }
  });

  it("keeps a live Grok turn over a saved pre-v17 maximum in either source order", () => {
    const turn = (timestampMs: number, outputTokens: number) =>
      record({
        provider: "grok",
        model: "grok-4.5",
        timestampMs,
        dedupeKey: `s:p:${timestampMs}:grok-4.5`,
        reportedCostUsd: outputTokens / 10,
        totals: { ...record().totals, uncachedInputTokens: 0, outputTokens },
      });
    const first = turn(Date.parse("2026-08-08T10:00:00Z"), 10);
    const resumed = turn(Date.parse("2026-08-08T11:00:00Z"), 20);
    const savedMaximum = { ...first, totals: resumed.totals, reportedCostUsd: 2 };

    const expected = aggregate([first, resumed]).buckets;

    for (const order of [
      [first, resumed, savedMaximum],
      [savedMaximum, first, resumed],
    ]) {
      const result = aggregate(order);
      expect(result.duplicatesDropped).toBe(1);
      expect(result.buckets).toEqual(expected);
    }
  });

  it("does not count a key whose first copy fell outside the window", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:", timestampMs: Date.parse("2026-07-01T12:00:00Z") }),
      record({ dedupeKey: "msg_1:", totals: { ...record().totals, outputTokens: 500 } }),
    ]);

    expect(result.duplicatesDropped).toBe(1);
    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("tallies kept records once each by why they count where they do", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      modelFilter: { exclude: [{ model: "claude-excluded" }] },
      attributeOrigin: (item) =>
        item.sessionId === "phone-session"
          ? { origin: "phone", basis: "stamp", reason: "typed" }
          : item.sessionId === "crew-session"
            ? { origin: "computer", basis: "default", via: "crew", reason: "noCause" }
            : item.sessionId === "caused-crew-session"
              ? { origin: "phone", basis: "stamp", via: "crew", reason: "inherited", folder: true }
              : null,
    });
    for (const item of [
      record({ sessionId: "phone-session", dedupeKey: "msg_1:" }),
      record({ sessionId: "phone-session", dedupeKey: "msg_1:" }),
      record({ sessionId: "phone-session", model: "claude-excluded" }),
      record({ sessionId: "phone-session", timestampMs: Date.parse("2026-07-30T00:00:00Z") }),
      record({ sessionId: "crew-session" }),
      record({ sessionId: "caused-crew-session" }),
      record({ sessionId: "terminal-session" }),
    ]) {
      aggregator.add(item, "/claude");
    }
    const result = aggregator.finish();

    const recordCost = result.buckets[0]!.costUsd / 4;
    expect(result.buckets[0]?.records).toBe(4);
    // The same usage by why it counts there, with no via split and the folder match kept.
    const reason = { provider: "claude", tokens: 1160, records: 1 } as const;
    expect(result.originReasons).toEqual([
      {
        ...reason,
        origin: "computer",
        reason: "noCause",
        byDefault: true,
        costUsd: expect.closeTo(recordCost),
      },
      {
        ...reason,
        origin: "phone",
        reason: "inherited",
        folder: true,
        byDefault: false,
        costUsd: expect.closeTo(recordCost),
      },
      {
        ...reason,
        origin: "phone",
        reason: "typed",
        byDefault: false,
        costUsd: expect.closeTo(recordCost),
      },
    ]);
  });

  it("exports each counted record once, merged, priced and labelled as the totals count it", () => {
    const counted: CountedRecord[] = [];
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      attributeOrigin: (item) =>
        item.sessionId === "phone-session"
          ? {
              origin: "phone",
              basis: "stamp",
              reason: "typed",
              root: { threadId: "thread-1", messageId: "message-1" },
            }
          : item.sessionId === "crew-session"
            ? { origin: "computer", basis: "default", via: "crew", reason: "noCause", cause: true }
            : null,
      attributeWork: (item, filePath) =>
        item.cwd === "/repos/app"
          ? { group: "Tooling", member: null }
          : filePath === "/claude/trader/s.jsonl"
            ? { group: "Trading", member: null }
            : null,
      onRecord: (entry) => counted.push(entry),
    });
    const outputCopy = { ...record().totals, outputTokens: 80 };
    for (const item of [
      record({ sessionId: "phone-session", dedupeKey: "msg_1:", cwd: "/repos/app" }),
      record({ sessionId: "phone-session", dedupeKey: "msg_1:", totals: outputCopy }),
      record({ sessionId: "phone-session", timestampMs: Date.parse("2026-07-30T00:00:00Z") }),
      record({ sessionId: "crew-session", model: "unpriced-model" }),
    ]) {
      aggregator.add(item, "/claude");
    }
    aggregator.add(record({ sessionId: "terminal-session" }), "/claude", "/claude/trader/s.jsonl");
    const result = aggregator.finish();

    const exported = counted.map((entry) => toUsageExportRecord(entry, false));
    const tokens = { input: 100, cacheRead: 1000, cacheWrite: 10 };
    const base = { at: "2026-08-07T04:05:13.944Z", provider: "claude", final: false } as const;
    // Keyed usage is counted in finish(), after the unkeyed records.
    expect(exported).toEqual([
      {
        ...base,
        model: "unpriced-model",
        sessionId: "crew-session",
        callId: null,
        tokens: { ...tokens, output: 50 },
        costUsd: null,
        origin: {
          device: "computer",
          started: "orchestrated",
          via: "crew",
          basis: "default",
          reason: "noCause",
          process: "other",
          cause: true,
        },
        group: null,
      },
      {
        ...base,
        model: "claude-fable-5",
        sessionId: "terminal-session",
        callId: null,
        tokens: { ...tokens, output: 50 },
        costUsd: expect.closeTo(0.004625, 9),
        origin: null,
        group: "Trading",
      },
      {
        ...base,
        model: "claude-fable-5",
        sessionId: "phone-session",
        callId: "msg_1:",
        tokens: { ...tokens, output: 80 },
        costUsd: expect.closeTo(0.006125, 9),
        origin: {
          device: "phone",
          started: "direct",
          basis: "stamp",
          reason: "typed",
          process: "other",
          promptThreadId: "thread-1",
        },
        group: "Tooling",
      },
    ]);
    expect(exported.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)).toBeCloseTo(
      result.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
      9,
    );
  });

  it("splits each bucket by device band, process and group, so the parts add up to the bucket", () => {
    const at = (iso: string) => Date.parse(iso);
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      // Upkeep counts by how it started, like any other computer work. A journal typed on the
      // phone is journal work; only declared upkeep is a routine, a coordinator's own is other.
      attributeOrigin: (item) =>
        item.sessionId === "phone"
          ? { origin: "phone", basis: "stamp", reason: "journal" }
          : item.sessionId === "upkeep"
            ? { origin: "computer", basis: "default", reason: "upkeep", via: "agent" }
            : item.sessionId === "early"
              ? { origin: "computer", basis: "beforeOrigins", reason: "beforeStamps" }
              : { origin: "computer", basis: "claim", reason: "upkeep" },
      // Tooling opens into its members; Trading does not.
      attributeWork: (item, filePath) =>
        item.cwd === "/repos/app"
          ? { group: "Tooling", member: "app" }
          : filePath === "/claude/trader/s.jsonl"
            ? { group: "Trading", member: null }
            : null,
    });
    const day7 = at("2026-08-07T04:00:00Z");
    for (const [item, filePath] of [
      [record({ sessionId: "phone", cwd: "/repos/app", timestampMs: day7 }), undefined],
      // A copy counts where its first copy was read, in that copy's transcript.
      [
        record({ sessionId: "upkeep", dedupeKey: "k1", timestampMs: day7 }),
        "/claude/trader/s.jsonl",
      ],
      [record({ sessionId: "upkeep", dedupeKey: "k1", timestampMs: day7 }), "/claude/other.jsonl"],
      [record({ sessionId: "laptop", timestampMs: day7 }), "/claude/other.jsonl"],
      [
        record({ sessionId: "early", cwd: "/repos/app", timestampMs: at("2026-08-02T00:00:00Z") }),
        undefined,
      ],
    ] as const) {
      aggregator.add(item, "/claude", filePath);
    }
    const [early, day] = aggregator.finish().buckets;

    const part = record().totals;
    const tokens =
      part.uncachedInputTokens +
      part.cachedInputTokens +
      part.cacheCreationTokens +
      part.outputTokens;
    const cost = day!.costUsd / 3;
    const amount = [tokens, expect.closeTo(cost, 6)];
    // A bucket all in one band names it alone.
    expect(early).toMatchObject({ devices: "unlabelled", work: "Tooling" });
    // A bucket all other sends no process split.
    expect(early?.processes).toBeUndefined();
    expect(day?.processes).toEqual({ journal: amount, other: amount, routines: amount });
    expect(day?.devices).toEqual({
      phoneDirect: amount,
      computerOrchestrated: amount,
      computerDirect: amount,
    });
    expect(day?.work).toEqual({ Tooling: amount, Trading: amount, "": amount });
    // Only usage in a group that opens into members is split by member, always with its amount.
    expect(day?.workMembers).toEqual({ app: amount });
    expect(Object.keys(early?.workMembers ?? {})).toEqual(["app"]);
  });

  it.each([
    ["session-a", "session-b"],
    ["session-b", "session-a"],
  ])("exports one call read first from %s under the same callId", (first, second) => {
    const counted: CountedRecord[] = [];
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      onRecord: (entry) => counted.push(entry),
    });
    aggregator.add(record({ sessionId: first, dedupeKey: "msg_1:req_1" }), "/claude");
    aggregator.add(record({ sessionId: second, dedupeKey: "msg_1:req_1" }), "/claude");
    aggregator.finish();

    expect(
      counted.map((entry) => {
        const { sessionId, callId } = toUsageExportRecord(entry, false);
        return { sessionId, callId };
      }),
    ).toEqual([{ sessionId: first, callId: "msg_1:req_1" }]);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("finds the day at a quarter-hour zone's midnight across interleaved buckets", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-01T18:14:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-01T18:15:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-01T18:15:00.000Z"), model: "claude-opus-5" }),
        record({ timestampMs: Date.parse("2026-08-01T18:16:00.000Z") }),
      ],
      "Asia/Kathmandu",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.model, bucket.records])).toEqual([
      ["2026-08-01", "claude-fable-5", 1],
      ["2026-08-02", "claude-fable-5", 2],
      ["2026-08-02", "claude-opus-5", 1],
    ]);
  });

  it("finds the day at a fixed offset's midnight between quarter hours", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-01T23:58:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-01T23:59:00.000Z") }),
      ],
      "+00:01",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.records])).toEqual([
      ["2026-08-01", 1],
      ["2026-08-02", 1],
    ]);
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("folds a mapped model into its target and prices it there", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      modelAliases: resolveModelAliases({ "example-preview": "claude-fable-5" }),
      rateModel: () => "claude-fable",
    });
    aggregator.add(record());
    aggregator.add(record({ model: "example-preview", rateModel: "example-preview-high" }));
    const result = aggregator.finish();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.model).toBe("claude-fable-5");
    expect(result.buckets[0]?.records).toBe(2);
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.00925, 9);
    expect(result.buckets[0]?.unpricedRecords).toBe(0);
  });
});

describe("resolveModelAliases", () => {
  it("follows chains to the final model and drops chains that enter a loop", () => {
    expect([
      ...resolveModelAliases({
        "preview[1m]": "preview",
        preview: "example-model",
        shared: "preview",
        intoLoop: "loop",
        loop: "back",
        back: "loop",
        laterIntoLoop: "back",
        deepIntoLoop: "intoLoop",
        self: "self",
        validAfterLoops: "shared",
      }),
    ]).toEqual([
      ["preview[1m]", "example-model"],
      ["preview", "example-model"],
      ["shared", "example-model"],
      ["validAfterLoops", "example-model"],
    ]);
  });
});
