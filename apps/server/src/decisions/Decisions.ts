import {
  CommandId,
  DecisionActError,
  DecisionReplyError,
  DecisionsState,
  EMPTY_DECISIONS_STATE,
  KeptThreadReplyError,
  MessageId,
  ThreadId,
  decisionSince,
  formatDecisionReply,
  formatKeptThreadReply,
  type Decision,
  type DecisionAction,
  type DecisionActInput,
  type DecisionActResult,
  type DecisionActionsInput,
  type DecisionActionsResult,
  type DecisionReplyInput,
  type DecisionReplyResult,
  type DecisionUndoReplyInput,
  type DecisionUndoReplyResult,
  type DecisionsSetInput,
  type KeptThreadReplyInput,
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { forkParked } from "../serverActivation.ts";

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
    /** FirstMate's chat, where replies go: the last list's `replyTo`. */
    readonly replyTo: Effect.Effect<ThreadId | null>;
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
    /** Sends the user's words about a crew thread to its coordinator; the thread itself gets nothing. */
    readonly replyToKeptThread: (
      input: KeptThreadReplyInput,
      origin?: OrchestrationClientOrigin,
    ) => Effect.Effect<DecisionReplyResult, KeptThreadReplyError>;
    /** Logs the user's snooze, bring back or archive for FirstMate to apply. */
    readonly act: (input: DecisionActInput) => Effect.Effect<DecisionActResult, DecisionActError>;
    /** FirstMate's side: drops acknowledged actions, then returns or waits for the next ones. */
    readonly actions: (
      input: DecisionActionsInput,
    ) => Effect.Effect<DecisionActionsResult, DecisionsStoreError>;
  }
>()("t3/decisions/Decisions") {}

/** An older sender's `wakeAt` is a snooze until then, put off since the decision began waiting. */
const asSent = ({ wakeAt, ...decision }: Decision) =>
  wakeAt === undefined || decision.snoozed !== undefined
    ? decision
    : { ...decision, snoozed: { at: decisionSince(decision) ?? wakeAt, until: wakeAt } };

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
        const decisions = input.decisions.map((received): StoredDecision => {
          const sent = asSent(received);
          const kept = previous.get(sent.id);
          if (kept === undefined) return sent;
          const { answered: _answered, refused: _refused, ...keptAsSent } = kept;
          return Equal.equals(keptAsSent, sent) ? kept : sent;
        });
        return { ...current, replyTo: input.replyTo, decisions };
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

  const replyToKeptThread = Effect.fn("Decisions.replyToKeptThread")(function* (
    input: KeptThreadReplyInput,
    origin?: OrchestrationClientOrigin,
  ) {
    const { threadId } = input;
    yield* Effect.annotateCurrentSpan({ "thread.id": threadId });
    const kept = yield* readThread(threadId);
    if (kept === null) return yield* new KeptThreadReplyError({ threadId, reason: "not-found" });
    const coordinatorId = kept.crewOf;
    if (coordinatorId === undefined || (yield* readThread(coordinatorId)) === null) {
      return yield* new KeptThreadReplyError({ threadId, reason: "no-coordinator" });
    }
    const keptFailed = (cause: unknown) => {
      const detail = userFacingDispatchErrorMessage(cause);
      return new KeptThreadReplyError({
        threadId,
        reason: "failed",
        ...(detail === undefined ? {} : { detail }),
        cause,
      });
    };
    const messageId = MessageId.make(`${input.commandId}:kept-reply`);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:kept-reply`),
        threadId: coordinatorId,
        messageId,
        text: formatKeptThreadReply({ thread: kept, text: input.text }),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: input.creationSource ?? "web",
        ...(origin === undefined ? {} : { origin }),
      })
      .pipe(Effect.mapError(keptFailed));
    const run = yield* findReplyRun(coordinatorId, messageId).pipe(Effect.mapError(keptFailed));
    return {
      coordinatorThreadId: coordinatorId,
      messageId,
      runId: run?.id ?? null,
      queued: run?.status === "queued",
    };
  });

  // Callers hold `writeLock`. A repeated `commandId` returns the action already logged.
  const logAction = (
    current: DecisionsState,
    action: Omit<DecisionAction, "seq">,
  ): { readonly next: DecisionsState; readonly seq: number } => {
    const logged = current.actions.find((entry) => entry.commandId === action.commandId);
    if (logged !== undefined) return { next: current, seq: logged.seq };
    const seq = current.lastActionSeq + 1;
    return {
      seq,
      next: {
        ...withDecision(current, action.itemId, ({ refused: _refused, ...item }) => item),
        actions: [...current.actions, { ...action, seq }],
        lastActionSeq: seq,
      },
    };
  };

  const act = Effect.fn("Decisions.act")(function* (input: DecisionActInput) {
    const { decisionId } = input;
    yield* Effect.annotateCurrentSpan({
      "decision.id": decisionId,
      "decision.action": input.action.type,
    });
    const at = DateTime.formatIso(yield* DateTime.now);
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const item = current.decisions.find((candidate) => candidate.id === decisionId);
        if (item === undefined)
          return yield* new DecisionActError({ decisionId, reason: "not-found" });
        // Archive closes the item, so it must be the version the user read; snooze is harmless.
        if (input.action.type === "archive" && input.revision !== item.revision) {
          return yield* new DecisionActError({ decisionId, reason: "updated" });
        }
        const { next, seq } = logAction(current, {
          commandId: input.commandId,
          itemId: decisionId,
          revision: input.revision,
          type: input.action.type,
          ...(input.action.type === "snooze" ? { until: input.action.until } : {}),
          at,
        });
        yield* save(current, next).pipe(
          Effect.mapError((cause) => new DecisionActError({ decisionId, reason: "failed", cause })),
        );
        return { seq };
      }),
    );
  });

  const pendingAfter = (current: DecisionsState, after: number): DecisionActionsResult => ({
    actions: current.actions.filter((action) => action.seq > after),
    lastSeq: current.lastActionSeq,
  });

  const actions = Effect.fn("Decisions.actions")(function* (input: DecisionActionsInput) {
    const acks = new Map((input.ack ?? []).map((ack) => [ack.seq, ack]));
    if (acks.size > 0) {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* mutate((current) => {
        let decisions = current.decisions;
        for (const action of current.actions) {
          const ack = acks.get(action.seq);
          if (ack?.outcome !== "refused") continue;
          decisions = decisions.map((item) =>
            item.id === action.itemId && item.revision === action.revision
              ? {
                  ...item,
                  refused: {
                    type: action.type,
                    ...(ack.message === undefined ? {} : { message: ack.message }),
                    at,
                  },
                }
              : item,
          );
        }
        const remaining = current.actions.filter((action) => !acks.has(action.seq));
        return Effect.succeed({ ...current, decisions, actions: remaining });
      });
    }
    const after = input.after ?? 0;
    const now = pendingAfter(yield* SubscriptionRef.get(state), after);
    if (now.actions.length > 0 || (input.waitMs ?? 0) === 0) return now;
    const next = yield* SubscriptionRef.changes(state).pipe(
      Stream.map((current) => pendingAfter(current, after)),
      Stream.filter((pending) => pending.actions.length > 0),
      Stream.runHead,
      Effect.timeoutOption(input.waitMs ?? 0),
    );
    return Option.isSome(next) && Option.isSome(next.value) ? next.value.value : now;
  });

  // FirstMate learns of a listed thread's archive, from its card or anywhere else, at once.
  const noteThreadEvent = (threadId: ThreadId, eventId: string, archived: boolean) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const carried = current.decisions.filter((item) => item.thread?.id === threadId);
        if (carried.length === 0) return;
        const at = DateTime.formatIso(yield* DateTime.now);
        let next = current;
        for (const item of carried) {
          next = logAction(next, {
            commandId: CommandId.make(`${eventId}:${item.id}`),
            itemId: item.id,
            revision: item.revision,
            type: archived ? "thread-archived" : "thread-unarchived",
            at,
          }).next;
        }
        yield* save(current, next);
      }),
    );

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      event.type === "thread.archived" || event.type === "thread.unarchived"
        ? noteThreadEvent(event.threadId, event.id, event.type === "thread.archived").pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not log a thread's archive for FirstMate.", { cause }),
            ),
          )
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Decisions stopped watching thread archives.", { cause }),
      ),
    ),
  );

  return Decisions.of({
    changes: SubscriptionRef.changes(state),
    replyTo: SubscriptionRef.get(state).pipe(Effect.map((current) => current.replyTo)),
    set,
    reply,
    undoReply,
    replyToKeptThread,
    act,
    actions,
  });
});

export const layer = Layer.effect(Decisions, make);
