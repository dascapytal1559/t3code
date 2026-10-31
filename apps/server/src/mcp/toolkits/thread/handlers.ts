import {
  type CommandId,
  type OrchestrationV2RuntimeRequest,
  ProviderRequestKind,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertFullAccess,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { effectiveRuntimeMode } from "../../../orchestration-v2/RuntimePolicy.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const isApprovalKind = Schema.is(ProviderRequestKind);

const pendingApproval = (
  request: OrchestrationV2RuntimeRequest,
  kind: ProviderRequestKind,
  turnItems: OrchestrationV2ThreadProjection["turnItems"],
) => {
  const item = turnItems.findLast(
    (item) => item.type === "approval_request" && item.requestId === request.id,
  );
  const approval = item?.type === "approval_request" ? item : undefined;
  return {
    requestId: request.id,
    type: "approval" as const,
    kind,
    ...(approval?.prompt === undefined ? {} : { detail: approval.prompt }),
    ...(approval?.reason === undefined ? {} : { reason: approval.reason }),
    override: approval?.fullAccessOverride ?? null,
    supportsFeedback:
      request.responseCapability.type === "live" &&
      request.responseCapability.supportsFeedback === true,
  };
};

const readPendingRequest = Effect.fn("mcp.readPendingRequest")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId,
  );
  const kind = request?.kind;
  if (request !== undefined && isApprovalKind(kind)) {
    if (request.status !== "pending")
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          request.status === "resolved"
            ? "The approval was already answered."
            : `The approval is no longer pending (${request.status}).`,
      });
    return {
      ...context,
      approval: pendingApproval(request, kind, context.projection.turnItems),
      item: undefined,
    };
  }
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request?.kind !== "user_input" || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, approval: undefined, item };
});
/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        taskId: task.id,
        threadId,
        ...(threadId === null
          ? {}
          : {
              link: McpInvocationContext.threadLinkFor(scope, threadId),
            }),
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({ ...input, projectId: input.projectId ?? caller?.projectId })
        .pipe(Effect.mapError(unavailable));
      return {
        matches: matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId),
        })),
      };
    }),
  ),
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_thread_configure: McpToolAccess.either(
    (input) => input.modelSelection === undefined && input.coordinator === undefined,
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const {
          projection: { thread },
        } = yield* readThread(input.threadId);
        const provider = (yield* ProviderRegistry.ProviderRegistry.pipe(
          Effect.flatMap((registry) => registry.getProviders),
        )).find((candidate) => candidate.instanceId === thread.modelSelection.instanceId);
        return {
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          effectiveRuntimeMode: effectiveRuntimeMode(
            thread.runtimeMode,
            provider?.supportedRuntimeModes,
          ),
          interactionMode: thread.interactionMode,
          ...(thread.environment === undefined ? {} : { environment: thread.environment }),
          ...(thread.instructions === undefined ? {} : { instructions: thread.instructions }),
          coordinator: thread.coordinator === true,
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        let sequence = 0;
        if (input.modelSelection !== undefined) {
          const modelSelection = input.modelSelection;
          const type = modelSelectionCommandType(thread.providerInstanceId, modelSelection);
          sequence = (yield* threads
            .dispatch({
              type,
              threadId: thread.id,
              commandId: yield* newCommandId(),
              modelSelection,
            })
            .pipe(Effect.mapError(dispatchFailure))).sequence;
        }
        if (input.coordinator !== undefined) {
          sequence = (yield* threads
            .setCoordinator({
              projectId: thread.projectId,
              threadId: thread.id,
              commandId: yield* newCommandId(),
              coordinator: input.coordinator,
            })
            .pipe(Effect.mapError(dispatchFailure))).sequence;
        }
        return { sequence };
      }),
    ),
  ),
  t3_pending_request: McpToolAccess.either(
    (input) => input.action !== "respond",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.action === "list") {
          const { projection } = yield* readThread(input.threadId, [
            "runtimeRequests",
            "turnItems",
          ]);
          const pending = projection.runtimeRequests.filter(
            (request) => request.status === "pending",
          );
          return {
            requestIds: pending
              .filter((request) => request.kind === "user_input")
              .map((request) => request.id),
            approvals: pending.flatMap((request) => {
              const kind = request.kind;
              return isApprovalKind(kind)
                ? [pendingApproval(request, kind, projection.turnItems)]
                : [];
            }),
          };
        }
        const requestId = yield* required(input.requestId, "requestId");
        const { approval, item } = yield* readPendingRequest({
          threadId: input.threadId,
          requestId,
        });
        return approval ?? { requestId, questions: item.questions };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const requestId = yield* required(input.requestId, "requestId");
        const pending = yield* readPendingRequest({ threadId: input.threadId, requestId });
        const common = {
          type: "runtime-request.respond" as const,
          threadId: pending.projection.thread.id,
          commandId: yield* newCommandId(),
          requestId,
          respondedBy: "agent" as const,
        };
        if (pending.approval === undefined) {
          if (input.decision !== undefined || input.feedback !== undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "A question takes `answers`, not `decision` or `feedback`.",
            });
          const answers = yield* required(input.answers, "answers");
          const result = yield* pending.threads
            .dispatch({ ...common, answers })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence };
        }
        // An approval grants what full access allows; the asking agent may not grant its own.
        if (pending.projection.thread.id === pending.scope.thread?.threadId)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A thread cannot answer its own approval.",
          });
        yield* assertFullAccess(
          pending,
          "Answering an approval needs a full-access calling thread or client.",
        );
        const decision = yield* required(input.decision, "decision");
        const result = yield* pending.threads
          .dispatch({
            ...common,
            decision: decision === "allow" ? "accept" : "decline",
            ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        return (
          queueEntry(projection, queuedRunId, 16000) ??
          (yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          }))
        );
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.edit",
              runId,
              text,
            }));
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
