import {
  type CommandId,
  isDelegatedAppThread,
  isPrimaryCoordinator,
  parseGoalCommand,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ProjectClearAfterQuiet,
  type ProviderInstanceId,
  type RunId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { isActiveRun, isNativeMaintenanceCommand } from "./CommandPolicy.ts";

// FirstMate rebuilds about 71k tokens from its files at session start, so a
// smaller session reloads cold for about the price of a fresh one.
const COORDINATOR_MIN_CONTEXT_TOKENS = 100_000;
// Claude's longest prompt cache lifetime. A request served fully from cache
// writes no cache entry, so its usage reports no expiry.
const MAX_PROMPT_CACHE_TTL_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

/**
 * Fork: when a thread counts as cold. `cache` is when Claude's prompt cache has expired and the
 * session is over `minContextTokens`; other providers report no cache lifetime, so never.
 * `quiet` is when no run has started or ended on the thread for `minutes`, on any provider.
 */
export type ColdClearRule =
  | { readonly kind: "cache"; readonly minContextTokens: number }
  | { readonly kind: "quiet"; readonly minutes: number };

/**
 * Fork: the cold-clear rule, or undefined where it is off: FirstMate's main thread always clears
 * on cache expiry over 100k, and a project's own threads follow its `clearAfterQuiet`.
 */
export function coldClearRule(
  thread: Pick<OrchestrationV2AppThread, "coordinator" | "crewOf" | "lineage" | "delegatedFrom">,
  project: { readonly clearAfterQuiet?: ProjectClearAfterQuiet | null | undefined } | undefined,
): ColdClearRule | undefined {
  if (isPrimaryCoordinator(thread)) {
    return { kind: "cache", minContextTokens: COORDINATOR_MIN_CONTEXT_TOKENS };
  }
  // Crew and delegated threads carry another agent's work, which a fresh session would lose.
  if (thread.crewOf !== undefined || isDelegatedAppThread(thread)) return undefined;
  const setting = project?.clearAfterQuiet ?? undefined;
  if (setting === undefined) return undefined;
  return setting === "cache"
    ? { kind: "cache", minContextTokens: 0 }
    : { kind: "quiet", minutes: setting };
}

export interface ColdClearRecords {
  readonly thread: Pick<OrchestrationV2AppThread, "id">;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage">
  >;
  readonly runtimeRequests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status">>;
  readonly contextTransfers: ReadonlyArray<
    Pick<OrchestrationV2ContextTransfer, "type" | "targetThreadId" | "status">
  >;
}

/** The input about to start a run, with the markers of a run it would continue. */
export interface ColdClearInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly freshContext?: boolean | undefined;
  readonly notification?: OrchestrationV2Notification | undefined;
  readonly delegatedCompletion?: unknown;
  readonly restartContinuationOfRunId?: RunId | undefined;
  readonly usageLimitContinuationOfRunId?: RunId | undefined;
  readonly manualContinuationOfRunId?: RunId | undefined;
  readonly steerFollowUpOfRunId?: RunId | undefined;
}

/**
 * Fork: whether a run about to start should start a fresh session because the session it would
 * resume is cold under `rule` (see `coldClearRule`). Only an input that begins a new exchange
 * qualifies; one that continues work the old session started stays in it.
 */
export function startsFreshWhenCold(
  { thread, runs, providerTurns, runtimeRequests, contextTransfers }: ColdClearRecords,
  providerThread:
    | Pick<
        OrchestrationV2ProviderThread,
        "id" | "driver" | "providerInstanceId" | "nativeThreadRef"
      >
    | undefined,
  input: ColdClearInput,
  { nowMs, rule }: { readonly nowMs: number; readonly rule: ColdClearRule | undefined },
): boolean {
  if (rule === undefined || input.freshContext === true) return false;
  if (
    isNativeMaintenanceCommand(input) ||
    // Goal controls act on the old session's goal.
    parseGoalCommand(input) !== null ||
    input.delegatedCompletion !== undefined ||
    // T3's own system notes (restart, session rotation) are the only wakes that begin an
    // exchange; the rest report on old work, and a provider-buffered wake's lives in the old session.
    (input.notification !== undefined && input.notification.source.kind !== "system") ||
    input.restartContinuationOfRunId !== undefined ||
    input.usageLimitContinuationOfRunId !== undefined ||
    input.manualContinuationOfRunId !== undefined ||
    input.steerFollowUpOfRunId !== undefined
  ) {
    return false;
  }
  if (coldClearWaits({ thread, runs, runtimeRequests, contextTransfers })) return false;
  // A provider switch re-reads no cache and hands the old context over on purpose.
  if (providerThread?.providerInstanceId !== input.providerInstanceId) return false;
  const coldAt = coldAtMs({ runs, providerTurns }, providerThread, rule);
  return coldAt !== undefined && nowMs >= coldAt;
}

/** Fork: work that keeps the thread's session as it is: a live run, a question, a fork or merge. */
export function coldClearWaits({
  thread,
  runs,
  runtimeRequests,
  contextTransfers,
}: Pick<ColdClearRecords, "thread" | "runs" | "runtimeRequests" | "contextTransfers">): boolean {
  return (
    runs.some(isActiveRun) ||
    runtimeRequests.some((request) => request.status === "pending") ||
    contextTransfers.some(
      (transfer) =>
        (transfer.type === "fork" || transfer.type === "merge_back") &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  );
}

/**
 * Fork: when `providerThread`'s session turns cold under `rule`, or undefined if it never does
 * on these records: no session yet, a small one, or a provider that reports no cache lifetime.
 */
export function coldAtMs(
  { runs, providerTurns }: Pick<ColdClearRecords, "runs" | "providerTurns">,
  providerThread:
    | Pick<OrchestrationV2ProviderThread, "id" | "driver" | "nativeThreadRef">
    | undefined,
  rule: ColdClearRule,
): number | undefined {
  if (providerThread === undefined || providerThread.nativeThreadRef === null) return undefined;
  if (rule.kind === "quiet") {
    // A queued run, this one included, has not touched the session yet.
    const lastActiveMs = Math.max(
      ...runs.flatMap((run) =>
        run.startedAt === null ? [] : [DateTime.toEpochMillis(run.completedAt ?? run.startedAt)],
      ),
    );
    return Number.isFinite(lastActiveMs) ? lastActiveMs + rule.minutes * MINUTE_MS : undefined;
  }
  // Only Claude reports cache expiry.
  if (providerThread.driver !== "claudeAgent") return undefined;
  const usage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (usage === undefined || usage.usedTokens <= rule.minContextTokens) return undefined;
  const expiresMs =
    usage.promptCacheExpiresAt === undefined
      ? Date.parse(usage.updatedAt) + MAX_PROMPT_CACHE_TTL_MS
      : Date.parse(usage.promptCacheExpiresAt);
  return Number.isFinite(expiresMs) ? expiresMs : undefined;
}

export type SessionRotationReason = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.session.rotate" }
>["reason"];

const SESSION_ROTATION_MESSAGE_PREFIX = "message:session-rotation:";

export const sessionRotationMessageId = (commandId: CommandId) =>
  MessageId.make(`${SESSION_ROTATION_MESSAGE_PREFIX}${commandId}`);

export const isSessionRotationMessage = (messageId: MessageId) =>
  messageId.startsWith(SESSION_ROTATION_MESSAGE_PREFIX);

/** Fork: the note T3 sends FirstMate's main thread to start a fresh session. */
export function sessionRotationNote(reason: SessionRotationReason): {
  readonly summary: string;
  readonly text: string;
} {
  return {
    summary: "T3 started a new session",
    text: [
      reason === "requested"
        ? "T3 started a new session for this thread at the user's request."
        : "T3 started a new session for this thread because the previous one's prompt cache had expired.",
      "No action needed: reply with one line.",
    ].join(" "),
  };
}
