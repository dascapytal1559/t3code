import { describe, expect, it } from "@effect/vitest";
import {
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

import { startsFreshOnColdCache, type ColdCacheInput, type ColdCacheRecords } from "./ColdCache.ts";

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
const COLD: ColdCacheRecords = {
  thread: { id: threadId, coordinator: true },
  runs: [RUN],
  providerTurns: [{ providerThreadId, tokenUsage: USAGE }],
  runtimeRequests: [],
  contextTransfers: [],
};
const INPUT: ColdCacheInput = {
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
type Case = readonly [string, ColdCacheRecords, Partial<ColdCacheInput>];
const decide = (records: ColdCacheRecords, input: Partial<ColdCacheInput>) =>
  startsFreshOnColdCache(records, PROVIDER_THREAD, { ...INPUT, ...input }, NOW_MS);

describe("startsFreshOnColdCache", () => {
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

  it.each<readonly [string, Parameters<typeof startsFreshOnColdCache>[1]]>([
    ["a thread with no earlier session", undefined],
    ["a session the provider never opened", { ...PROVIDER_THREAD, nativeThreadRef: null }],
    [
      "a provider that reports no cache expiry",
      { ...PROVIDER_THREAD, driver: ProviderDriverKind.make("codex") },
    ],
  ])("keeps the old session when it would resume %s", (_name, providerThread) => {
    expect(startsFreshOnColdCache(COLD, providerThread, INPUT, NOW_MS)).toBe(false);
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
    [
      "a switch to another provider",
      COLD,
      { providerInstanceId: ProviderInstanceId.make("codex") },
    ],
    ["an unpinned thread", { ...COLD, thread: { ...COLD.thread, coordinator: false } }, {}],
    [
      "a secondmate",
      { ...COLD, thread: { ...COLD.thread, crewOf: ThreadId.make("thread:fm") } },
      {},
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
  ])("keeps the old session for %s", (_name, records, input) => {
    expect(decide(records, input)).toBe(false);
  });
});
