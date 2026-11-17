import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  coldClearRule,
  startsFreshWhenCold,
  type ColdClearInput,
  type ColdClearRecords,
  type ColdClearRule,
} from "./ColdClear.ts";

const NOW_MS = Date.parse("2026-11-15T06:00:00.000Z");
const MINUTE_MS = 60_000;
const iso = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + offsetMs));
const threadId = ThreadId.make("thread:firstmate");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread:firstmate");

const RUN = {
  id: RunId.make("run:1"),
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-opus-5-5" },
  providerThreadId,
  userMessageId: MessageId.make("message:1"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: DateTime.makeUnsafe(NOW_MS - 120 * MINUTE_MS),
  startedAt: DateTime.makeUnsafe(NOW_MS - 120 * MINUTE_MS),
  completedAt: DateTime.makeUnsafe(NOW_MS - 61 * MINUTE_MS),
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;
const PROVIDER_THREAD = {
  id: providerThreadId,
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: instanceId,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: "session-1",
    strength: "strong" as const,
  },
};
const USAGE = {
  usedTokens: 250_000,
  promptCacheExpiresAt: iso(-MINUTE_MS),
  updatedAt: iso(-61 * MINUTE_MS),
} satisfies OrchestrationV2ProviderTurnTokenUsage;
type RuleThread = Parameters<typeof coldClearRule>[0];
const LOGGER: RuleThread = {
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
};
const FIRSTMATE: RuleThread = { ...LOGGER, coordinator: true };
const COLD: ColdClearRecords = {
  thread: { id: threadId },
  runs: [RUN],
  providerTurns: [{ providerThreadId, tokenUsage: USAGE }],
  runtimeRequests: [],
  contextTransfers: [],
};
const INPUT: ColdClearInput = {
  text: "What's next?",
  attachments: [],
  providerInstanceId: instanceId,
};

const withUsage = (...usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage>) => ({
  ...COLD,
  providerTurns: usages.map((tokenUsage) => ({ providerThreadId, tokenUsage })),
});
const notification = (
  source: OrchestrationV2Notification["source"],
): OrchestrationV2Notification => ({ source, outcome: "updated", summary: "Woke" });
const CACHE_RULE: ColdClearRule = { kind: "cache", minContextTokens: 0 };
const QUIET_RULE: ColdClearRule = { kind: "quiet", minutes: 10 };
type Case = readonly [string, ColdClearRecords, Partial<ColdClearInput>];
const FIRSTMATE_RULE = { nowMs: NOW_MS, rule: coldClearRule(FIRSTMATE, undefined) };
const decide = (records: ColdClearRecords, input: Partial<ColdClearInput>) =>
  startsFreshWhenCold(records, PROVIDER_THREAD, { ...INPUT, ...input }, FIRSTMATE_RULE);

describe("coldClearRule", () => {
  const cache = { clearAfterQuiet: "cache" as const };
  const tenMinutes = { clearAfterQuiet: 10 };
  it.each<
    readonly [string, RuleThread, Parameters<typeof coldClearRule>[1], ColdClearRule | undefined]
  >([
    ["FirstMate's main thread", FIRSTMATE, undefined, { kind: "cache", minContextTokens: 100_000 }],
    [
      "FirstMate's main thread in a project that sets its own",
      FIRSTMATE,
      tenMinutes,
      { kind: "cache", minContextTokens: 100_000 },
    ],
    ["a thread in a project that clears on cache expiry", LOGGER, cache, CACHE_RULE],
    ["a thread in a project that clears after quiet", LOGGER, tenMinutes, QUIET_RULE],
    ["a thread in a project that doesn't", LOGGER, { clearAfterQuiet: null }, undefined],
    ["a thread with no project record", LOGGER, undefined, undefined],
    ["a secondmate", { ...FIRSTMATE, crewOf: ThreadId.make("thread:fm") }, cache, undefined],
    ["a crew worker", { ...LOGGER, crewOf: ThreadId.make("thread:fm") }, tenMinutes, undefined],
    [
      "a subagent",
      { lineage: { ...LOGGER.lineage, relationshipToParent: "subagent" } },
      tenMinutes,
      undefined,
    ],
    [
      "a delegated task",
      {
        ...LOGGER,
        delegatedFrom: {
          environmentId: EnvironmentId.make("env:other"),
          threadId: ThreadId.make("thread:parent"),
          title: "Parent",
        },
      },
      tenMinutes,
      undefined,
    ],
  ])("for %s", (_name, thread, project, expected) => {
    expect(coldClearRule(thread, project)).toEqual(expected);
  });
});

describe("startsFreshWhenCold", () => {
  const withRule = (
    rule: ColdClearRule | undefined,
    records: ColdClearRecords = COLD,
    providerThread: Parameters<typeof startsFreshWhenCold>[1] = PROVIDER_THREAD,
  ) => startsFreshWhenCold(records, providerThread, INPUT, { nowMs: NOW_MS, rule });
  const endedAgo = (minutes: number) => ({
    ...COLD,
    runs: [{ ...RUN, completedAt: DateTime.makeUnsafe(NOW_MS - minutes * MINUTE_MS) }],
  });

  it("starts fresh over FirstMate's floor, and not at or under it", () => {
    const rule = { kind: "cache", minContextTokens: 100_000 } as const;
    expect(withRule(rule, withUsage({ ...USAGE, usedTokens: 100_001 }))).toBe(true);
    expect(withRule(rule, withUsage({ ...USAGE, usedTokens: 100_000 }))).toBe(false);
  });

  it("starts a project's small cold Claude session fresh too", () => {
    expect(withRule(CACHE_RULE, withUsage({ ...USAGE, usedTokens: 2_000 }))).toBe(true);
  });

  it("keeps the old session where the rule is off", () => {
    expect(withRule(undefined)).toBe(false);
  });

  it("starts fresh once the thread has been quiet for the set minutes, on any provider", () => {
    for (const driver of ["claudeAgent", "grok", "codex"]) {
      const providerThread = { ...PROVIDER_THREAD, driver: ProviderDriverKind.make(driver) };
      expect(withRule(QUIET_RULE, endedAgo(10), providerThread)).toBe(true);
      expect(withRule(QUIET_RULE, endedAgo(9), providerThread)).toBe(false);
    }
  });

  it("counts quiet from the latest run that started, warm cache or not", () => {
    const warm = withUsage({ ...USAGE, promptCacheExpiresAt: iso(30 * MINUTE_MS) });
    expect(withRule(QUIET_RULE, { ...warm, runs: endedAgo(11).runs })).toBe(true);
    expect(
      withRule(QUIET_RULE, {
        ...COLD,
        runs: [
          ...endedAgo(30).runs,
          { ...RUN, id: RunId.make("run:2"), completedAt: DateTime.makeUnsafe(NOW_MS - MINUTE_MS) },
        ],
      }),
    ).toBe(false);
    // The run about to start was queued just now and has not started yet.
    expect(
      withRule(QUIET_RULE, {
        ...COLD,
        runs: [
          ...endedAgo(30).runs,
          {
            ...RUN,
            id: RunId.make("run:2"),
            status: "queued",
            requestedAt: DateTime.makeUnsafe(NOW_MS),
            startedAt: null,
            completedAt: null,
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps the session of a provider that reports no cache expiry under the cache choice", () => {
    for (const driver of ["grok", "codex"]) {
      const providerThread = { ...PROVIDER_THREAD, driver: ProviderDriverKind.make(driver) };
      expect(withRule(CACHE_RULE, COLD, providerThread)).toBe(false);
    }
  });

  it.each<Case>([
    ["a new message after the cache expired", COLD, {}],
    ["the moment the cache expires", withUsage({ ...USAGE, promptCacheExpiresAt: iso(0) }), {}],
    ["T3's restart note", COLD, { notification: notification({ kind: "system" }) }],
    [
      "an hour after a request that reported no expiry",
      withUsage({ usedTokens: 250_000, updatedAt: iso(-60 * MINUTE_MS) }),
      {},
    ],
  ])("starts fresh for %s", (_name, records, input) => {
    expect(decide(records, input)).toBe(true);
  });

  it.each<readonly [string, Parameters<typeof startsFreshWhenCold>[1]]>([
    ["a thread with no earlier session", undefined],
    ["a session the provider never opened", { ...PROVIDER_THREAD, nativeThreadRef: null }],
  ])("keeps the old session when it would resume %s", (_name, providerThread) => {
    for (const rule of [CACHE_RULE, QUIET_RULE]) {
      expect(startsFreshWhenCold(COLD, providerThread, INPUT, { nowMs: NOW_MS, rule })).toBe(false);
    }
  });

  it.each<Case>([
    ["a warm cache", withUsage({ ...USAGE, promptCacheExpiresAt: iso(MINUTE_MS) }), {}],
    [
      "less than an hour after a request that reported no expiry",
      withUsage({ usedTokens: 250_000, updatedAt: iso(-59 * MINUTE_MS) }),
      {},
    ],
    [
      "an expired older request when the newest one is warm",
      withUsage(
        { ...USAGE, promptCacheExpiresAt: iso(30 * MINUTE_MS), updatedAt: iso(-30 * MINUTE_MS) },
        USAGE,
      ),
      {},
    ],
    ["a session of 100k tokens or less", withUsage({ ...USAGE, usedTokens: 100_000 }), {}],
    ["a session with no usage", { ...COLD, providerTurns: [] }, {}],
  ])("keeps the old session for %s", (_name, records, input) => {
    expect(decide(records, input)).toBe(false);
  });

  it.each<Case>([
    [
      "a switch to another provider",
      COLD,
      { providerInstanceId: ProviderInstanceId.make("codex") },
    ],
    ["a running turn", { ...COLD, runs: [{ ...RUN, status: "running" }] }, {}],
    ["a turn waiting on an answer", { ...COLD, runs: [{ ...RUN, status: "waiting" }] }, {}],
    ["a pending question or approval", { ...COLD, runtimeRequests: [{ status: "pending" }] }, {}],
    [
      "a pending fork",
      {
        ...COLD,
        contextTransfers: [{ type: "fork", targetThreadId: threadId, status: "pending" }],
      },
      {},
    ],
    [
      "a pending merge-back",
      {
        ...COLD,
        contextTransfers: [{ type: "merge_back", targetThreadId: threadId, status: "pending" }],
      },
      {},
    ],
    ["an armed /clear", COLD, { freshContext: true }],
    ["/compact", COLD, { text: "/compact" }],
    ["/logout", COLD, { text: "/logout" }],
    ["a goal control", COLD, { text: "/goal pause" }],
    ["a steer the running turn missed", COLD, { steerFollowUpOfRunId: RUN.id }],
    [
      "the continuation after a restart",
      COLD,
      { restartContinuationOfRunId: RUN.id, notification: notification({ kind: "system" }) },
    ],
    ["the resume after a usage limit", COLD, { usageLimitContinuationOfRunId: RUN.id }],
    ["a manual Continue", COLD, { manualContinuationOfRunId: RUN.id }],
    [
      "a delegated task reporting in",
      COLD,
      {
        notification: notification({ kind: "delegated_task", taskIds: [] }),
        delegatedCompletion: { parentRunId: RUN.id, generation: 1, taskIds: [] },
      },
    ],
    ["a pull request watch", COLD, { notification: notification({ kind: "monitor" }) }],
    ["a wake the old session buffered", COLD, { notification: notification({ kind: "subagent" }) }],
    ["a background command", COLD, { notification: notification({ kind: "command" }) }],
  ])("keeps the old session for %s, under either rule", (_name, records, input) => {
    expect(decide(records, input)).toBe(false);
    expect(
      startsFreshWhenCold(
        records,
        PROVIDER_THREAD,
        { ...INPUT, ...input },
        { nowMs: NOW_MS, rule: QUIET_RULE },
      ),
    ).toBe(false);
  });
});
