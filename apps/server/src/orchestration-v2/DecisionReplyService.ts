import {
  CommandId,
  MessageId,
  type OrchestrationClientOrigin,
  ThreadDecisionReplyError,
  formatThreadDecisionReply,
  type ThreadDecisionReplyInput,
  type ThreadDecisionReplyResult,
  type ThreadDecisionUndoReplyInput,
  type ThreadDecisionUndoReplyResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ThreadManagement from "./ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

/**
 * A decision thread has no agent. Replying sends one ordinary user message into the coordinator's
 * chat, queued behind a running turn as the composer's Queue does, and settles the decision.
 */
export class DecisionReplyService extends Context.Service<
  DecisionReplyService,
  {
    readonly reply: (
      input: ThreadDecisionReplyInput,
      origin?: OrchestrationClientOrigin,
    ) => Effect.Effect<ThreadDecisionReplyResult, ThreadDecisionReplyError>;
    /** Takes a reply back while it is still queued, and unsettles the decision. */
    readonly undoReply: (
      input: ThreadDecisionUndoReplyInput,
    ) => Effect.Effect<ThreadDecisionUndoReplyResult, ThreadDecisionReplyError>;
  }
>()("t3/orchestration-v2/DecisionReplyService") {}

// Every id derives from the client's command id, so a retry replays rather than resends.
const replyMessageId = (commandId: CommandId) => MessageId.make(`${commandId}:decision-reply`);
const stepCommandId = (commandId: CommandId, step: string) =>
  CommandId.make(`${commandId}:decision-${step}`);

const failed = (threadId: ThreadId) => (cause: unknown) => {
  const detail = userFacingDispatchErrorMessage(cause);
  return new ThreadDecisionReplyError({
    threadId,
    reason: "failed",
    ...(detail === undefined ? {} : { detail }),
    cause,
  });
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const readDecisionThread = Effect.fn("DecisionReplyService.readDecisionThread")(function* (
    threadId: ThreadId,
  ) {
    const { thread } = yield* threads
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(failed(threadId)));
    if (thread.deletedAt !== null || thread.decisionOf === undefined) {
      return yield* new ThreadDecisionReplyError({ threadId, reason: "not-a-decision" });
    }
    return { thread, coordinatorId: thread.decisionOf };
  });

  const findReplyRun = Effect.fn("DecisionReplyService.findReplyRun")(function* (
    coordinatorId: ThreadId,
    messageId: MessageId,
  ) {
    const { messages } = yield* threads.getThreadRecords(coordinatorId, ["messages"], {
      messageIds: [messageId],
    });
    const runId = messages.find((message) => message.id === messageId)?.runId ?? null;
    if (runId === null) return null;
    const { runs } = yield* threads.getThreadRecords(coordinatorId, ["runs"], { runIds: [runId] });
    return runs.find((run) => run.id === runId) ?? null;
  });

  const reply = Effect.fn("DecisionReplyService.reply")(function* (
    input: ThreadDecisionReplyInput,
    origin?: OrchestrationClientOrigin,
  ) {
    yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId });
    const { thread, coordinatorId } = yield* readDecisionThread(input.threadId);
    const decision = thread.decision;
    if (decision == null) {
      return yield* new ThreadDecisionReplyError({
        threadId: input.threadId,
        reason: "not-a-decision",
      });
    }
    if (input.revision !== undefined && input.revision !== decision.revision) {
      return yield* new ThreadDecisionReplyError({ threadId: input.threadId, reason: "updated" });
    }
    const coordinator = yield* threads.getThreadRecords(coordinatorId, []).pipe(
      Effect.map((records) => records.thread),
      Effect.orElseSucceed(() => null),
    );
    if (coordinator === null || coordinator.deletedAt !== null) {
      return yield* new ThreadDecisionReplyError({
        threadId: input.threadId,
        reason: "no-coordinator",
      });
    }
    const messageId = replyMessageId(input.commandId);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: stepCommandId(input.commandId, "reply"),
        threadId: coordinatorId,
        messageId,
        text: formatThreadDecisionReply({ decision, text: input.text }),
        attachments: [],
        // No delivery intent: it never steers a running turn, and starts one when idle.
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: input.creationSource ?? "web",
        ...(origin === undefined ? {} : { origin }),
      })
      .pipe(Effect.mapError(failed(input.threadId)));
    yield* threads
      .dispatch({
        type: "thread.settle",
        commandId: stepCommandId(input.commandId, "settle"),
        threadId: input.threadId,
      })
      .pipe(Effect.mapError(failed(input.threadId)));
    const run = yield* findReplyRun(coordinatorId, messageId).pipe(
      Effect.mapError(failed(input.threadId)),
    );
    return {
      coordinatorThreadId: coordinatorId,
      messageId,
      runId: run?.id ?? null,
      queued: run?.status === "queued",
    };
  });

  const undoReply = Effect.fn("DecisionReplyService.undoReply")(function* (
    input: ThreadDecisionUndoReplyInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId });
    const { coordinatorId } = yield* readDecisionThread(input.threadId);
    const readRun = findReplyRun(coordinatorId, replyMessageId(input.commandId)).pipe(
      Effect.mapError(failed(input.threadId)),
    );
    const run = yield* readRun;
    if (run === null || (run.status !== "queued" && run.status !== "cancelled")) {
      return { withdrawn: false };
    }
    if (run.status === "queued") {
      const cancelled = yield* threads
        .dispatch({
          type: "queued-run.cancel",
          commandId: stepCommandId(input.commandId, "undo-cancel"),
          threadId: coordinatorId,
          runId: run.id,
        })
        .pipe(Effect.result);
      // The queue may have started it in the meantime; then it is the coordinator's now.
      if (Result.isFailure(cancelled)) {
        const latest = yield* readRun;
        if (latest?.status === "queued") return yield* failed(input.threadId)(cancelled.failure);
        if (latest?.status !== "cancelled") return { withdrawn: false };
      }
    }
    yield* threads
      .dispatch({
        type: "thread.unsettle",
        commandId: stepCommandId(input.commandId, "undo-unsettle"),
        threadId: input.threadId,
        reason: "user",
      })
      .pipe(Effect.mapError(failed(input.threadId)));
    return { withdrawn: true };
  });

  return DecisionReplyService.of({ reply, undoReply });
});

export const layer: Layer.Layer<
  DecisionReplyService,
  never,
  ThreadManagement.ThreadManagementService
> = Layer.effect(DecisionReplyService, make);
