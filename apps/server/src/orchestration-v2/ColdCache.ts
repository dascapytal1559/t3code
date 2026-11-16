import {
  isDelegatedAppThread,
  isPrimaryCoordinator,
  parseGoalCommand,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ProviderInstanceId,
  type RunId,
} from "@t3tools/contracts";

import { isActiveRun, isNativeMaintenanceCommand } from "./CommandPolicy.ts";

// FirstMate rebuilds about 71k tokens from its files at session start, so a
// smaller session reloads cold for about the price of a fresh one.
const COORDINATOR_MIN_CONTEXT_TOKENS = 100_000;
// Claude's longest prompt cache lifetime. A request served fully from cache
// writes no cache entry, so its usage reports no expiry.
const MAX_PROMPT_CACHE_TTL_MS = 60 * 60_000;

/**
 * Fork: the context size over which a cold session starts fresh, or undefined where the rule is
 * off: always on for FirstMate's main thread, and on for a project's own threads when it opts in.
 */
export function coldClearMinContextTokens(
  thread: Pick<OrchestrationV2AppThread, "coordinator" | "crewOf" | "lineage" | "delegatedFrom">,
  project: { readonly coldClearMinTokens?: number | null | undefined } | undefined,
): number | undefined {
  if (isPrimaryCoordinator(thread)) return COORDINATOR_MIN_CONTEXT_TOKENS;
  // Crew and delegated threads carry another agent's work, which a fresh session would lose.
  if (thread.crewOf !== undefined || isDelegatedAppThread(thread)) return undefined;
  return project?.coldClearMinTokens ?? undefined;
}

export interface ColdCacheRecords {
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
export interface ColdCacheInput {
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
 * Fork: whether a run about to start should start a fresh session because the prompt cache of
 * the session it would resume has expired and that session is over `minContextTokens` (see
 * `coldClearMinContextTokens`). Only an input that begins a new exchange qualifies; one that
 * continues work the old session started stays in it.
 */
export function startsFreshOnColdCache(
  { thread, runs, providerTurns, runtimeRequests, contextTransfers }: ColdCacheRecords,
  providerThread:
    | Pick<
        OrchestrationV2ProviderThread,
        "id" | "driver" | "providerInstanceId" | "nativeThreadRef"
      >
    | undefined,
  input: ColdCacheInput,
  {
    nowMs,
    minContextTokens,
  }: { readonly nowMs: number; readonly minContextTokens: number | undefined },
): boolean {
  if (minContextTokens === undefined || input.freshContext === true) return false;
  if (
    isNativeMaintenanceCommand(input) ||
    // Goal controls act on the old session's goal.
    parseGoalCommand(input) !== null ||
    input.delegatedCompletion !== undefined ||
    // T3's restart note is the only wake that begins an exchange; the rest report on old work,
    // and a provider-buffered wake's content lives in the old session.
    (input.notification !== undefined && input.notification.source.kind !== "system") ||
    input.restartContinuationOfRunId !== undefined ||
    input.usageLimitContinuationOfRunId !== undefined ||
    input.manualContinuationOfRunId !== undefined ||
    input.steerFollowUpOfRunId !== undefined
  ) {
    return false;
  }
  if (
    runs.some(isActiveRun) ||
    runtimeRequests.some((request) => request.status === "pending") ||
    contextTransfers.some(
      (transfer) =>
        (transfer.type === "fork" || transfer.type === "merge_back") &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  ) {
    return false;
  }
  // Only Claude reports cache expiry, and a provider switch re-reads no cache.
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.providerInstanceId !== input.providerInstanceId ||
    providerThread.nativeThreadRef === null
  ) {
    return false;
  }
  const usage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (usage === undefined || usage.usedTokens <= minContextTokens) return false;
  const expiresMs =
    usage.promptCacheExpiresAt === undefined
      ? Date.parse(usage.updatedAt) + MAX_PROMPT_CACHE_TTL_MS
      : Date.parse(usage.promptCacheExpiresAt);
  return Number.isFinite(expiresMs) && nowMs >= expiresMs;
}
