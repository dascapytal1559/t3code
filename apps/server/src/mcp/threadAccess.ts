import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type OrchestrationV2CausedBy,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpFromThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageOrigins from "../usage/UsageOrigins.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import { fencingLinkOrigin } from "./linkOrigin.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const delegatedTaskPrefix = "thread:delegated-task:";

const suggestedThreadId = (threadId: ThreadId) => {
  if (!threadId.startsWith(delegatedTaskPrefix)) return ThreadId.make(`mcp:${threadId}`);
  const rest = threadId.slice(delegatedTaskPrefix.length);
  // encodeURIComponent throws on lone surrogates, which a JSON string can carry.
  if (!rest.isWellFormed()) return null;
  const encoded = encodeURIComponent(rest);
  return encoded === rest ? null : ThreadId.make(`${delegatedTaskPrefix}${encoded}`);
};

/**
 * Agents paste bare uuids for `mcp:<uuid>` threads and unencoded delegated-task ids.
 * The id is never rewritten, so permission checks keyed on it still hold; the miss
 * only names a live thread the caller could read by its full id. Ids from another
 * machine miss here too. The link hint is static: listing links probes peers.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  scope: McpInvocationContext.McpInvocationScope,
  threadId: ThreadId,
  message: string,
) {
  const suggested = suggestedThreadId(threadId);
  const shell =
    suggested === null
      ? null
      : yield* threads.getThreadShell(suggested).pipe(Effect.orElseSucceed(() => null));
  const mcpHint =
    shell === null || shell.deletedAt !== null ? "" : ` Did you mean \`${suggested}\`?`;
  const caller =
    scope.thread === undefined
      ? null
      : yield* threads.getThreadShell(scope.thread.threadId).pipe(Effect.orElseSucceed(() => null));
  // A peer link's caller would be pointed at this machine's links, and a fenced one may not use them.
  const linksHint =
    scope.linkedEnvironments === false ||
    scope.client?.linked === true ||
    fencingLinkOrigin({ scope, caller: caller ?? undefined }) !== undefined
      ? ""
      : " Thread ids belong to one environment: for a thread on a linked one, find it with `t3_environment_links` and pass its `environmentId` to a tool that takes one.";
  return yield* new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: `${message}${mcpHint}${linksHint}`,
  });
});

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

export const dispatchFailure = (
  error: OrchestratorV2Error | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
) =>
  error._tag === "ThreadManagementProviderInstanceDisabledError" ||
  error._tag === "OrchestratorRuntimeModeAboveCeilingError" ||
  error._tag === "OrchestratorProviderSelectionBusyError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : (error._tag === "OrchestratorDispatchError" ||
          error._tag === "OrchestratorCommandRejectedError") &&
        typeof error.cause === "string" &&
        error.cause.length > 0
      ? new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: Array.from(error.cause).slice(0, 1000).join(""),
        })
      : unavailable();

export interface CallerLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface Caller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly caller: OrchestrationV2ThreadShell | undefined;
  readonly limits: CallerLimits;
}

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  return yield* loadCaller();
});

export const loadCaller = Effect.fn("mcp.loadCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (scope.thread === undefined) {
    return {
      scope,
      threads,
      caller: undefined,
      limits: McpInvocationContext.clientModeCeiling(scope.client),
    } satisfies Caller;
  }
  const caller = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return {
    scope,
    threads,
    caller,
    limits: { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
  } satisfies Caller;
});

export const assertTargetWithinLimits = (
  limits: CallerLimits,
  target: Pick<OrchestrationV2ThreadShell, "id" | "runtimeMode" | "interactionMode">,
) =>
  resolveRuntimeMode(limits.runtimeMode, target.runtimeMode).pipe(
    Effect.andThen(resolveInteractionMode(limits.interactionMode, target.interactionMode)),
    Effect.asVoid,
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: error.code,
          message: `Thread "${target.id}" runs in ${target.runtimeMode}/${target.interactionMode}, above this caller's ${limits.runtimeMode}/${limits.interactionMode} limit. For linked calls, this limit is also capped by the link's approved access. This call does not create an approval request. Have the user act directly in the target thread through an authorized client.`,
        }),
    ),
  );

/** Background subagents retain credentials until provider exit; archived threads and other instances cannot act. */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

/** Thread callers need a live run or its background subagent in an unarchived thread. OAuth clients rely on their session and ceiling. */
export function assertLiveCaller({ caller, scope }: Caller) {
  if (caller === undefined) return Effect.void;
  return isLiveCallerShell(caller, scope.thread?.providerInstanceId)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      );
}

export const assertFullAccess = (context: Caller, message: string) =>
  context.limits.runtimeMode === "full-access" && context.limits.interactionMode === "default"
    ? Effect.void
    : Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }));

export const resolveProjectId = (context: Caller, projectId: ProjectId | undefined) =>
  projectId !== undefined
    ? Effect.succeed(projectId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.projectId)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass projectId: this MCP client is not running inside a T3 thread.",
          }),
        );

const resolveThreadId = (context: Caller, threadId: ThreadId | undefined) =>
  threadId !== undefined
    ? Effect.succeed(threadId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.id)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          }),
        );

export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = [], filter?: ProjectionRecordFilter) {
  const context = yield* readCaller();
  const targetId = yield* resolveThreadId(context, threadId);
  const shell = yield* context.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(
      context.threads,
      context.scope,
      targetId,
      "The thread was not found.",
    );
  }
  const projection = yield* context.threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request", "approval_request"],
      ...filter,
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found.",
            })
          : unavailable(),
      ),
    );
  return { ...context, projection };
});

const invalidCause = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: `causedBy: ${message}` });

/** A cause must name a prompt that exists, in a thread any caller may read, from the run it names. */
export const verifyCause = Effect.fn("mcp.verifyCause")(function* (
  threads: Pick<
    ThreadManagement.ThreadManagementService["Service"],
    "getThreadShell" | "getThreadRecords"
  >,
  cause: OrchestrationV2CausedBy,
) {
  const shell = yield* threads.getThreadShell(cause.threadId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* invalidCause(`thread ${cause.threadId} was not found.`);
  }
  const { messages } = yield* threads
    .getThreadRecords(cause.threadId, ["messages"], { messageIds: [cause.messageId] })
    .pipe(Effect.mapError(unavailable));
  const message = messages.find((candidate) => candidate.id === cause.messageId);
  if (message === undefined || message.role !== "user") {
    return yield* invalidCause(
      `message ${cause.messageId} is not a prompt in thread ${cause.threadId}.`,
    );
  }
  if (cause.runId !== undefined && message.runId !== cause.runId) {
    return yield* invalidCause(`message ${cause.messageId} is not part of run ${cause.runId}.`);
  }
  return cause;
});

const invalidFromThread = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: `fromThread: ${message}` });

/**
 * Where work a thread launches or sends counts, bound by value from that thread's turn at `at`
 * (now by default): the caller's own thread, or the one a caller outside threads names. Null when
 * neither names one, or when Usage cannot be read; accounting never holds work back.
 */
export const bindUsageOrigin = Effect.fn("mcp.bindUsageOrigin")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  fromThread: OrchestratorMcpFromThread | undefined,
  callerId: ThreadId | undefined,
) {
  if (fromThread !== undefined && callerId !== undefined && fromThread.threadId !== callerId) {
    return yield* invalidFromThread("an agent in a thread speaks only for its own thread.");
  }
  const threadId = fromThread?.threadId ?? callerId;
  if (threadId === undefined) return null;
  if (fromThread !== undefined) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* invalidFromThread(`thread ${threadId} was not found.`);
    }
  }
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const atMs = fromThread?.at === undefined ? nowMs : Math.min(Date.parse(fromThread.at), nowMs);
  const origins = yield* UsageOrigins.UsageOrigins;
  // A defect too: a bug in Usage must not stop the work it would have labelled.
  return yield* origins.originAt(threadId, atMs).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Usage could not bind work to its thread's origin", {
            threadId,
            cause,
          }).pipe(Effect.as(null)),
    ),
  );
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return CommandId.make(`mcp:${yield* random.uuidV4()}`);
});
