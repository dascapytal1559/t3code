import {
  CommandId,
  EMPTY_RULES_STATE,
  MessageId,
  RuleAnswerError,
  RulesState,
  formatRuleAnswer,
  type OrchestrationClientOrigin,
  type RuleAnswerInput,
  type RuleAnswerResult,
  type RulesSetInput,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as Decisions from "../decisions/Decisions.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";

export class RulesStoreError extends Schema.TaggedError<RulesStoreError>()("RulesStoreError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Failed to save the rules file.";
  }
}

/**
 * The user's rules for FirstMate, kept in one file beside the settings. FirstMate replaces the
 * whole list; the only thing kept here that it does not send is which recommendations the user
 * agreed to. Agreeing is one ordinary user message into FirstMate's chat, the decisions' `replyTo`.
 */
export class Rules extends Context.Service<
  Rules,
  {
    /** The current list, then every change. */
    readonly changes: Stream.Stream<RulesState>;
    /** Replaces the list. An identical list changes nothing, so it may be sent as often as wanted. */
    readonly set: (input: RulesSetInput) => Effect.Effect<RulesState, RulesStoreError>;
    readonly answer: (
      input: RuleAnswerInput,
      origin?: OrchestrationClientOrigin,
    ) => Effect.Effect<RuleAnswerResult, RuleAnswerError>;
  }
>()("t3/rules/Rules") {}

const RulesFile = Schema.fromJsonString(RulesState);
const decodeFile = Schema.decodeUnknownEffect(RulesFile);
const encodeFile = Schema.encodeEffect(RulesFile);

// Both ids derive from the client's command id, so a retry replays rather than resends.
const answerMessageId = (commandId: CommandId) => MessageId.make(`${commandId}:rule-answer`);
const answerCommandId = (commandId: CommandId) => CommandId.make(`${commandId}:rule-answer`);

const failed = (ruleId: string) => (cause: unknown) => {
  const detail = userFacingDispatchErrorMessage(cause);
  return new RuleAnswerError({
    ruleId,
    reason: "failed",
    ...(detail === undefined ? {} : { detail }),
    cause,
  });
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const decisions = yield* Decisions.Decisions;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "rules.json");

  // An unreadable file starts empty: FirstMate sends the whole list again on its next change.
  const stored = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeFile),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(EMPTY_RULES_STATE),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the rules file; starting with none.", {
        path: filePath,
        cause,
      }).pipe(Effect.as(EMPTY_RULES_STATE)),
    ),
  );
  const state = yield* SubscriptionRef.make(stored);
  const writeLock = yield* Semaphore.make(1);

  const mutate = <E>(change: (current: RulesState) => Effect.Effect<RulesState, E>) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const next = yield* change(current);
        if (Equal.equals(current, next)) return current;
        yield* encodeFile(next).pipe(
          Effect.flatMap((json) =>
            writeFileStringAtomically({ filePath, contents: `${json}\n` }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
          ),
          Effect.mapError((cause) => new RulesStoreError({ path: filePath, cause })),
        );
        yield* SubscriptionRef.set(state, next);
        return next;
      }),
    );

  const set = Effect.fn("Rules.set")(function* (input: RulesSetInput) {
    return yield* mutate((current) => {
      // An agreed recommendation stays sent while FirstMate sends the rule unchanged.
      const previous = new Map(current.rules.map((rule) => [rule.id, rule]));
      const incoming = new Map(input.rules.map((rule) => [rule.id, rule]));
      const sent = current.sent.filter((id) => {
        const next = incoming.get(id);
        return next?.status === "pending" && Equal.equals(previous.get(id), next);
      });
      return Effect.succeed({ rules: input.rules, sent });
    });
  });

  const answer = Effect.fn("Rules.answer")(function* (
    input: RuleAnswerInput,
    origin?: OrchestrationClientOrigin,
  ) {
    const { ruleId } = input;
    yield* Effect.annotateCurrentSpan({ "rule.id": ruleId });
    const rule = (yield* SubscriptionRef.get(state)).rules.find(
      (candidate) => candidate.id === ruleId,
    );
    if (rule === undefined || rule.status !== "pending") {
      return yield* new RuleAnswerError({ ruleId, reason: "not-found" });
    }
    if (!Equal.equals(rule.recommendation, input.recommendation)) {
      return yield* new RuleAnswerError({ ruleId, reason: "updated" });
    }
    const coordinatorId = yield* decisions.replyTo;
    const coordinator =
      coordinatorId === null
        ? null
        : yield* threads.getThreadRecords(coordinatorId, []).pipe(
            Effect.map((records) => (records.thread.deletedAt === null ? records.thread : null)),
            Effect.orElseSucceed(() => null),
          );
    if (coordinatorId === null || coordinator === null) {
      return yield* new RuleAnswerError({ ruleId, reason: "no-coordinator" });
    }
    const messageId = answerMessageId(input.commandId);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: answerCommandId(input.commandId),
        threadId: coordinatorId,
        messageId,
        text: formatRuleAnswer(rule),
        attachments: [],
        // As a decision reply: never steers a running turn, and starts one when idle.
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: input.creationSource ?? "web",
        ...(origin === undefined ? {} : { origin }),
      })
      .pipe(Effect.mapError(failed(ruleId)));
    // FirstMate may have changed the rule meanwhile; that version was not the one agreed to.
    yield* mutate((current) => {
      const latest = current.rules.find((candidate) => candidate.id === ruleId);
      return Effect.succeed(
        Equal.equals(latest, rule) && !current.sent.includes(ruleId)
          ? { ...current, sent: [...current.sent, ruleId] }
          : current,
      );
    }).pipe(Effect.mapError(failed(ruleId)));
    const { messages } = yield* threads
      .getThreadRecords(coordinatorId, ["messages"], { messageIds: [messageId] })
      .pipe(Effect.mapError(failed(ruleId)));
    const runId = messages.find((message) => message.id === messageId)?.runId ?? null;
    return { coordinatorThreadId: coordinatorId, messageId, runId };
  });

  return Rules.of({ changes: SubscriptionRef.changes(state), set, answer });
});

export const layer = Layer.effect(Rules, make);
