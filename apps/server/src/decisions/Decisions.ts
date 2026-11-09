import {
  CommandId,
  DecisionReplyError,
  DecisionsState,
  EMPTY_DECISIONS_STATE,
  MessageId,
  ThreadId,
  formatDecisionReply,
  type DecisionReplyInput,
  type DecisionReplyResult,
  type DecisionUndoReplyInput,
  type DecisionUndoReplyResult,
  type DecisionsSetInput,
  type OrchestrationClientOrigin,
  type StoredDecision,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";

export class DecisionsStoreError extends Schema.TaggedError<DecisionsStoreError>()(
  "DecisionsStoreError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to save the decisions file.";
  }
}

export class DecisionsReplyThreadError extends Schema.TaggedError<DecisionsReplyThreadError>()(
  "DecisionsReplyThreadError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `replyTo thread ${this.threadId} was not found.`;
  }
}

/**
 * The decisions FirstMate needs from the user, kept in one file beside the settings. FirstMate
 * replaces the whole list; the only thing kept here that it does not send is which decisions the
 * user has answered. A reply is one ordinary user message into FirstMate's chat.
 */
export class Decisions extends Context.Service<
  Decisions,
  {
    /** The current list, then every change. */
    readonly changes: Stream.Stream<DecisionsState>;
    /**
     * Replaces the list. A decision left out is gone; one that changed shows again even if it was
     * answered; an identical list changes nothing, so callers may send it as often as they like.
     */
    readonly set: (
      input: DecisionsSetInput,
    ) => Effect.Effect<DecisionsState, DecisionsStoreError | DecisionsReplyThreadError>;
    readonly reply: (
      input: DecisionReplyInput,
      origin?: OrchestrationClientOrigin,
    ) => Effect.Effect<DecisionReplyResult, DecisionReplyError>;
    /** Takes a reply back while it is still queued, and shows the decision again. */
    readonly undoReply: (
      input: DecisionUndoReplyInput,
    ) => Effect.Effect<DecisionUndoReplyResult, DecisionReplyError>;
  }
>()("t3/decisions/Decisions") {}

const DecisionsFile = Schema.fromJsonString(DecisionsState);
const decodeFile = Schema.decodeUnknownEffect(DecisionsFile);
const encodeFile = Schema.encodeEffect(DecisionsFile);

// Every id derives from the client's command id, so a retry replays rather than resends.
const replyMessageId = (commandId: CommandId) => MessageId.make(`${commandId}:decision-reply`);
const stepCommandId = (commandId: CommandId, step: string) =>
  CommandId.make(`${commandId}:decision-${step}`);

const failed = (decisionId: string) => (cause: unknown) => {
  const detail = userFacingDispatchErrorMessage(cause);
  return new DecisionReplyError({
    decisionId,
    reason: "failed",
    ...(detail === undefined ? {} : { detail }),
    cause,
  });
};

const withDecision = (
  current: DecisionsState,
  decisionId: string,
  change: (decision: StoredDecision) => StoredDecision,
): DecisionsState => ({
  ...current,
  decisions: current.decisions.map((decision) =>
    decision.id === decisionId ? change(decision) : decision,
  ),
});

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "decisions.json");

  // An unreadable file starts empty: FirstMate sends the whole list again on its next change.
  const stored = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeFile),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(EMPTY_DECISIONS_STATE),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the decisions file; starting with none.", {
        path: filePath,
        cause,
      }).pipe(Effect.as(EMPTY_DECISIONS_STATE)),
    ),
  );
  const state = yield* SubscriptionRef.make(stored);
  const writeLock = yield* Semaphore.make(1);

  // Callers hold `writeLock`.
  const save = Effect.fnUntraced(function* (current: DecisionsState, next: DecisionsState) {
    if (Equal.equals(current, next)) return current;
    yield* encodeFile(next).pipe(
      Effect.flatMap((json) =>
        writeFileStringAtomically({ filePath, contents: `${json}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.mapError((cause) => new DecisionsStoreError({ path: filePath, cause })),
    );
    yield* SubscriptionRef.set(state, next);
    return next;
  });

  const mutate = <E>(change: (current: DecisionsState) => Effect.Effect<DecisionsState, E>) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        return yield* save(current, yield* change(current));
      }),
    );

  const changeDecision = (
    decisionId: string,
    change: (decision: StoredDecision) => StoredDecision,
  ) => mutate((current) => Effect.succeed(withDecision(current, decisionId, change)));

  const readThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map((records) => (records.thread.deletedAt === null ? records.thread : null)),
      Effect.orElseSucceed(() => null),
    );

  const set = Effect.fn("Decisions.set")(function* (input: DecisionsSetInput) {
    return yield* mutate(
      // Untraced: it runs inside this operation's own span.
      Effect.fnUntraced(function* (current) {
        if (input.replyTo !== current.replyTo && (yield* readThread(input.replyTo)) === null) {
          return yield* new DecisionsReplyThreadError({ threadId: input.replyTo });
        }
        const previous = new Map(current.decisions.map((decision) => [decision.id, decision]));
        const decisions = input.decisions.map((sent): StoredDecision => {
          const kept = previous.get(sent.id);
          if (kept === undefined) return sent;
          const { answered: _answered, ...asSent } = kept;
          return Equal.equals(asSent, sent) ? kept : sent;
        });
        return { replyTo: input.replyTo, decisions };
      }),
    );
  });

  const findReplyRun = Effect.fn("Decisions.findReplyRun")(function* (
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

  const reply = Effect.fn("Decisions.reply")(function* (
    input: DecisionReplyInput,
    origin?: OrchestrationClientOrigin,
  ) {
    const { decisionId } = input;
    yield* Effect.annotateCurrentSpan({ "decision.id": decisionId });
    const current = yield* SubscriptionRef.get(state);
    const decision = current.decisions.find((candidate) => candidate.id === decisionId);
    if (decision === undefined) {
      return yield* new DecisionReplyError({ decisionId, reason: "not-found" });
    }
    if (input.revision !== undefined && input.revision !== decision.revision) {
      return yield* new DecisionReplyError({ decisionId, reason: "updated" });
    }
    const coordinatorId = current.replyTo;
    if (coordinatorId === null || (yield* readThread(coordinatorId)) === null) {
      return yield* new DecisionReplyError({ decisionId, reason: "no-coordinator" });
    }
    const messageId = replyMessageId(input.commandId);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: stepCommandId(input.commandId, "reply"),
        threadId: coordinatorId,
        messageId,
        text: formatDecisionReply({ decision, text: input.text }),
        attachments: [],
        // No delivery intent: it never steers a running turn, and starts one when idle.
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: input.creationSource ?? "web",
        ...(origin === undefined ? {} : { origin }),
      })
      .pipe(Effect.mapError(failed(decisionId)));
    const at = DateTime.formatIso(yield* DateTime.now);
    // FirstMate may have changed the decision meanwhile; that version was not the one answered.
    yield* changeDecision(decisionId, (latest) =>
      latest.revision === decision.revision
        ? { ...latest, answered: { commandId: input.commandId, at } }
        : latest,
    ).pipe(Effect.mapError(failed(decisionId)));
    const run = yield* findReplyRun(coordinatorId, messageId).pipe(
      Effect.mapError(failed(decisionId)),
    );
    return {
      coordinatorThreadId: coordinatorId,
      messageId,
      runId: run?.id ?? null,
      queued: run?.status === "queued",
    };
  });

  const undoReply = Effect.fn("Decisions.undoReply")(function* (input: DecisionUndoReplyInput) {
    const { decisionId } = input;
    yield* Effect.annotateCurrentSpan({ "decision.id": decisionId });
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const coordinatorId = current.replyTo;
        if (coordinatorId === null) {
          return yield* new DecisionReplyError({ decisionId, reason: "no-coordinator" });
        }
        const readRun = findReplyRun(coordinatorId, replyMessageId(input.commandId)).pipe(
          Effect.mapError(failed(decisionId)),
        );
        const run = yield* readRun;
        if (run === null || (run.status !== "queued" && run.status !== "cancelled")) {
          return { withdrawn: false };
        }
        if (run.status === "queued") {
          if (!current.decisions.some((decision) => decision.id === decisionId)) {
            return { withdrawn: false };
          }
          const cancelled = yield* threads
            .dispatch({
              type: "queued-run.cancel",
              commandId: stepCommandId(input.commandId, "undo-cancel"),
              threadId: coordinatorId,
              runId: run.id,
            })
            .pipe(Effect.result);
          // The queue may have started it in the meantime; then it is FirstMate's now.
          if (Result.isFailure(cancelled)) {
            const latest = yield* readRun;
            if (latest?.status === "queued") return yield* failed(decisionId)(cancelled.failure);
            if (latest?.status !== "cancelled") return { withdrawn: false };
          }
        }
        const reopened = withDecision(current, decisionId, (latest) => {
          if (latest.answered?.commandId !== input.commandId) return latest;
          const { answered: _answered, ...open } = latest;
          return open;
        });
        yield* save(current, reopened).pipe(Effect.mapError(failed(decisionId)));
        return { withdrawn: true };
      }),
    );
  });

  return Decisions.of({ changes: SubscriptionRef.changes(state), set, reply, undoReply });
});

export const layer = Layer.effect(Decisions, make);
