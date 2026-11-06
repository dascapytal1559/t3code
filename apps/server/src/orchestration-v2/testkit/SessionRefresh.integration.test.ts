import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as SessionRefreshService from "../SessionRefreshService.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread:session-refresh");
const projectId = ProjectId.make("project:session-refresh");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * One Claude-shaped adapter whose sessions and turns write to `log`, so a test can read the
 * order of session closes against turn starts. Each native thread gets a new id, and nothing
 * resumes across them, as a fresh Claude session would.
 */
function makeAdapter(input: {
  readonly log: Ref.Ref<ReadonlyArray<string>>;
  readonly injectedHistory: Ref.Ref<number>;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  /** The session reports background work, such as a running background command. */
  readonly busy?: boolean;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const modelSelection: ModelSelection = CLAUDE_MODEL_SELECTION;
  const note = (line: string) => Ref.update(input.log, (lines) => [...lines, line]);
  // Native thread ids never repeat across sessions, as Claude's session ids do not.
  let generation = 0;
  return {
    instanceId: modelSelection.instanceId,
    driver: CLAUDE_DRIVER,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* note(`opened:${sessionInput.providerSessionId}`);
        yield* Effect.addFinalizer(() => note(`closed:${sessionInput.providerSessionId}`));
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: CLAUDE_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: modelSelection.model,
          capabilities: ClaudeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const unimplemented = (detail: string) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({ driver: CLAUDE_DRIVER, detail }),
          );
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: modelSelection.instanceId,
          driver: CLAUDE_DRIVER,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `claude:${threadInput.threadId}:${generation}`;
              generation += 1;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: CLAUDE_DRIVER,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: CLAUDE_DRIVER,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          injectHistory: () =>
            Ref.update(input.injectedHistory, (count) => count + 1).pipe(Effect.as(true)),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* note(
                `turn:${turnInput.runOrdinal}:${turnInput.providerThread.nativeThreadRef?.nativeId ?? "none"}`,
              );
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const failed = input.failedRunOrdinals?.has(turnInput.runOrdinal) === true;
              const status = failed ? ("failed" as const) : ("completed" as const);
              const terminal: ProviderAdapter.ProviderAdapterV2Event = failed
                ? {
                    type: "turn.terminal",
                    driver: CLAUDE_DRIVER,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal: turnInput.runOrdinal,
                    status: "failed",
                    failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                    failure: makeProviderFailure({
                      message: "Simulated provider failure.",
                      code: "simulated_failure",
                      class: "provider_error",
                    }),
                    threadDisposition: "reusable",
                  }
                : {
                    type: "turn.terminal",
                    driver: CLAUDE_DRIVER,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal: turnInput.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  };
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: CLAUDE_DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: CLAUDE_DRIVER,
                      nativeId: `native-turn:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status,
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: CLAUDE_DRIVER,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status,
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: `reply ${turnInput.runOrdinal} to ${turnInput.message.text}`,
                    streaming: false,
                  },
                },
                terminal,
              ];
              for (const event of providerEvents) yield* PubSub.publish(events, event);
            }),
          ...(input.busy === true ? { hasPendingBackgroundWork: Effect.succeed(true) } : {}),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused"),
          rollbackThread: () => unimplemented("rollbackThread unused"),
          forkThread: () => unimplemented("forkThread unused"),
        };
        return runtime;
      }),
  };
}

interface RefreshContext {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly log: Ref.Ref<ReadonlyArray<string>>;
  readonly injectedHistory: Ref.Ref<number>;
  readonly send: (
    ordinal: number,
    text: string,
  ) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, Orchestrator.OrchestratorV2Error>;
  readonly waitRun: (
    ordinal: number,
  ) => Effect.Effect<
    void,
    Orchestrator.OrchestratorV2Error | EffectWorker.OrchestrationEffectWorkerError
  >;
}

const run = <E>(
  name: string,
  options: { readonly failedRunOrdinals?: ReadonlySet<number>; readonly busy?: boolean },
  body: (context: RefreshContext) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`session-refresh-${name}`);
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const injectedHistory = yield* Ref.make(0);
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeAdapter({
          log,
          injectedHistory,
          ...(options.failedRunOrdinals === undefined
            ? {}
            : { failedRunOrdinals: options.failedRunOrdinals }),
          ...(options.busy === undefined ? {} : { busy: options.busy }),
        }),
      ]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        // Started before any turn, as the server starts it, so it sees the whole thread.
        yield* SessionRefreshService.make.pipe(Effect.flatMap((service) => service.start()));
        const send = (ordinal: number, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`refresh-test:${ordinal}`),
            threadId,
            messageId: MessageId.make(`refresh-test:${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
        const waitRun: RefreshContext["waitRun"] = (ordinal) =>
          orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.ordinal === ordinal &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
            Effect.andThen(worker.drain()),
            Effect.asVoid,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("refresh-test:create"),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Context refresh",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* body({ orchestrator, log, injectedHistory, send, waitRun });
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: `session-refresh-${name}`,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            layerRegistry,
          ),
        ),
      );
    }),
  );

const refresh = (orchestrator: Orchestrator.OrchestratorV2["Service"]) =>
  orchestrator.dispatch({
    type: "thread.session.refresh",
    commandId: CommandId.make("refresh-test:refresh"),
    threadId,
  });

describe("context refresh", () => {
  it.live("stows, ends the old session before the fresh one starts, then opens without ahoy", () =>
    run("replace", {}, ({ orchestrator, log, injectedHistory, send, waitRun }) =>
      Effect.gen(function* () {
        yield* send(1, "Hello");
        yield* waitRun(1);
        const before = yield* orchestrator.getThreadProjection(threadId);
        const oldProviderThreadId = before.thread.activeProviderThreadId;
        assert.isNotNull(oldProviderThreadId);

        yield* refresh(orchestrator);
        yield* waitRun(3);

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          after.runs.map((run) => [run.ordinal, run.status]),
          [
            [1, "completed"],
            [2, "completed"],
            [3, "completed"],
          ],
        );
        const texts = new Map(after.messages.map((message) => [message.runId, message.text]));
        assert.equal(texts.get(after.runs[1]!.id), "/stow");
        assert.equal(texts.get(after.runs[2]!.id), "Context refreshed.");
        // The stow turn ran on the old session; the opening message on a new provider thread.
        assert.equal(after.runs[1]!.providerThreadId, oldProviderThreadId);
        assert.notEqual(after.runs[2]!.providerThreadId, oldProviderThreadId);
        assert.equal(after.thread.activeProviderThreadId, after.runs[2]!.providerThreadId);
        // Upstream's fresh session: the opening run is the context boundary, and its message
        // draws the New session divider.
        assert.isTrue(after.runs[2]!.freshContext);
        const opening = after.turnItems.find(
          (item) => item.type === "user_message" && item.text === "Context refreshed.",
        );
        assert.isTrue(opening?.type === "user_message" && opening.freshContext === true);
        assert.isFalse(after.turnItems.some((item) => item.type === "system_notice"));

        // Fresh: nothing was injected, and the new native thread is not the old one.
        assert.equal(yield* Ref.get(injectedHistory), 0);
        const lines = yield* Ref.get(log);
        const turns = lines.filter((line) => line.startsWith("turn:"));
        const nativeThreadOf = (line: string) => line.split(":").slice(2).join(":");
        assert.equal(turns.length, 3);
        assert.equal(nativeThreadOf(turns[0]!), nativeThreadOf(turns[1]!));
        assert.notEqual(nativeThreadOf(turns[1]!), nativeThreadOf(turns[2]!));
        // The old process was gone before the fresh session opened.
        const closed = lines.findIndex((line) => line.startsWith("closed:"));
        const reopened = lines.findIndex(
          (line, index) => index > closed && line.startsWith("opened:"),
        );
        assert.isAbove(closed, 0);
        assert.isAbove(reopened, closed);
        assert.isAbove(lines.indexOf(turns[2]!), reopened);
      }),
    ),
  );

  it.live("keeps the session and says so when /stow fails", () =>
    run("kept", { failedRunOrdinals: new Set([2]) }, ({ orchestrator, log, send, waitRun }) =>
      Effect.gen(function* () {
        yield* send(1, "Hello");
        yield* waitRun(1);
        const before = yield* orchestrator.getThreadProjection(threadId);

        yield* refresh(orchestrator);
        yield* waitRun(2);
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "turn-item.updated" && event.payload.type === "system_notice",
          ),
          Stream.runHead,
        );

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.length, 2);
        assert.equal(after.runs[1]!.status, "failed");
        assert.equal(after.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
        const notice = after.turnItems.find((item) => item.type === "system_notice");
        assert.include(
          notice?.type === "system_notice" ? notice.message : "",
          "The agent session was kept.",
        );
        assert.isFalse((yield* Ref.get(log)).some((line) => line.startsWith("closed:")));
      }),
    ),
  );

  it.live("keeps the session and says so when the agent is still busy", () =>
    run("busy-session", { busy: true }, ({ orchestrator, log, send, waitRun }) =>
      Effect.gen(function* () {
        yield* send(1, "Hello");
        yield* waitRun(1);
        const before = yield* orchestrator.getThreadProjection(threadId);

        yield* refresh(orchestrator);
        yield* waitRun(2);
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "turn-item.updated" && event.payload.type === "system_notice",
          ),
          Stream.runHead,
        );

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.length, 2);
        assert.equal(after.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
        const notice = after.turnItems.find((item) => item.type === "system_notice");
        assert.equal(
          notice?.type === "system_notice" ? notice.message : "",
          "Context refresh stopped: the agent was still busy. The agent session was kept.",
        );
        assert.isFalse((yield* Ref.get(log)).some((line) => line.startsWith("closed:")));
      }),
    ),
  );

  it.live("refuses while a turn is running", () =>
    run("busy", {}, ({ orchestrator, send, waitRun }) =>
      Effect.gen(function* () {
        yield* send(1, "Hello");
        const refused = yield* Effect.exit(refresh(orchestrator));
        assert.isTrue(Exit.isFailure(refused));
        yield* waitRun(1);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs.length, 1);
      }),
    ),
  );
});
