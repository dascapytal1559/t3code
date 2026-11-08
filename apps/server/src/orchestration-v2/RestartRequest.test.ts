import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** One server over `layerDatabase`; building it again over the same database is a restart. */
const layerServer = (
  layerDatabase: Layer.Layer<SqlClient.SqlClient, never> | typeof SqlitePersistence.layerMemory,
) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "restart-request" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );

const dispatch = (command: OrchestrationV2Command) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch(command);
  });

const createThread = (threadId: ThreadId) =>
  dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:restart-request"),
    title: threadId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

const composerSend = (
  threadId: ThreadId,
  text: string,
  dispatchMode: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["dispatchMode"] = { type: "start_immediately" },
) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}:${text}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${text}`),
    text,
    attachments: [],
    dispatchMode,
    createdBy: "user",
    creationSource: "web",
  });

// What `t3_thread_send` dispatches for an agent.
const mcpSend = (threadId: ThreadId, text: string) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`mcp-send:${threadId}:${text}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${text}`),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "mcp",
  });

const runs = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.map(
      (run) =>
        `${run.status}${run.queueHeld === true ? (run.restartHold === true ? ":restart" : ":held") : ""}`,
    );
  });

const completeLatestStartedRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
      (candidate) => candidate.status === "starting",
    )!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${run.id}:completed`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
  });

const requestRestart = Effect.gen(function* () {
  yield* (yield* Orchestrator.OrchestratorV2).requestRestart({
    reason: "install build 0.1.8",
    requestedBy: "FirstMate",
  });
});

it.effect("a pending restart queues every new turn, held, while running turns finish", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const idle = ThreadId.make("thread:restart-idle");
    const busy = ThreadId.make("thread:restart-busy");
    yield* createThread(idle);
    yield* createThread(busy);
    yield* composerSend(busy, "running");
    yield* composerSend(busy, "queued before the request", { type: "queue_after_active" });

    yield* requestRestart;
    assert.deepEqual(yield* runs(busy), ["starting", "queued:restart"]);
    assert.deepInclude(yield* orchestrator.restartStatus, {
      pending: true,
      reason: "install build 0.1.8",
      activeTurns: 1,
      drained: false,
    });

    // The composer and an agent's send both queue on an idle thread instead of starting.
    yield* composerSend(idle, "from the composer");
    yield* mcpSend(idle, "from FirstMate");
    assert.deepEqual(yield* runs(idle), ["queued:restart", "queued:restart"]);
    // A steer would grow the running turn, so it queues too.
    const running = (yield* orchestrator.getThreadProjection(busy)).runs[0]!;
    yield* composerSend(busy, "steer", { type: "steer_active", targetRunId: running.id });
    assert.deepEqual(yield* runs(busy), ["starting", "queued:restart", "queued:restart"]);

    // A second request only replaces the reason.
    const first = yield* orchestrator.restartRequest;
    yield* orchestrator.requestRestart({ reason: "install build 0.1.9", requestedBy: "Other" });
    assert.deepEqual(yield* orchestrator.restartRequest, {
      ...first!,
      reason: "install build 0.1.9",
    });

    // The running turn finishes; nothing queued starts after it.
    yield* completeLatestStartedRun(busy);
    assert.strictEqual(yield* orchestrator.resumeQueuedRuns, 0);
    assert.deepEqual(yield* runs(busy), ["completed", "queued:restart", "queued:restart"]);
    assert.deepInclude(yield* orchestrator.restartStatus, { activeTurns: 0, drained: true });
  }).pipe(Effect.provide(layerServer(SqlitePersistence.layerMemory))),
);

it.effect("a cancel and the next server start release only the restart's holds", () =>
  Effect.gen(function* () {
    const layerSameDatabase = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
    const stopped = ThreadId.make("thread:restart-stopped");
    const cancelled = ThreadId.make("thread:restart-cancelled");
    const restarted = ThreadId.make("thread:restart-restarted");
    const stoppedWhilePending = ThreadId.make("thread:restart-stopped-while-pending");

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const threadId of [stopped, cancelled, restarted, stoppedWhilePending]) {
        yield* createThread(threadId);
      }
      yield* composerSend(stopped, "running");
      yield* composerSend(stopped, "kept by Stop", { type: "queue_after_active" });
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop"),
        threadId: stopped,
      });
      assert.deepEqual(yield* runs(stopped), ["interrupted", "queued:held"]);

      yield* requestRestart;
      yield* composerSend(cancelled, "first");
      yield* composerSend(cancelled, "second");
      yield* orchestrator.cancelRestart;
      // Released in order: the first starts and the second waits behind it, unheld.
      assert.deepEqual(yield* runs(cancelled), ["starting", "queued"]);
      assert.deepEqual(yield* runs(stopped), ["interrupted", "queued:held"]);
      assert.isNull(yield* orchestrator.restartRequest);

      yield* composerSend(stoppedWhilePending, "running");
      yield* requestRestart;
      yield* composerSend(restarted, "after the restart");
      // Stop during the wait takes the hold over, so the restart leaves this queue stopped.
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-while-pending"),
        threadId: stoppedWhilePending,
      });
      yield* composerSend(stoppedWhilePending, "sent after Stop");
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-again"),
        threadId: stoppedWhilePending,
      });
      assert.deepEqual(yield* runs(restarted), ["queued:restart"]);
      // A request holds what was already queued, too.
      assert.deepEqual(yield* runs(cancelled), ["starting", "queued:restart"]);
      assert.deepEqual(yield* runs(stoppedWhilePending), ["interrupted", "queued:held"]);
    }).pipe(Effect.provide(layerServer(layerSameDatabase)));

    // The next server starts with no request and releases what the old one held.
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      assert.isNull(yield* orchestrator.restartRequest);
      assert.strictEqual(yield* orchestrator.releaseRestartHolds, 2);
      assert.deepEqual(yield* runs(restarted), ["starting"]);
      assert.deepEqual(yield* runs(cancelled), ["starting", "queued"]);
      assert.deepEqual(yield* runs(stopped), ["interrupted", "queued:held"]);
      assert.deepEqual(yield* runs(stoppedWhilePending), ["interrupted", "queued:held"]);
    }).pipe(Effect.provide(layerServer(layerSameDatabase)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a workspace launch prepares during a pending restart and waits to start", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:restart-launch");
    yield* createThread(threadId);
    yield* requestRestart;
    yield* composerSend(threadId, "prepare first", { type: "defer_start" });
    assert.deepEqual(yield* runs(threadId), ["preparing"]);
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* dispatch({
      type: "prepared-run.release",
      commandId: CommandId.make("release-prepared"),
      threadId,
      runId: run.id,
    });
    assert.deepEqual(yield* runs(threadId), ["queued:restart"]);
    // The timeline shows the message as queued, not as a sent turn.
    const message = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
      (item) => item.type === "user_message",
    );
    assert.deepInclude(message, { inputIntent: "queued_turn", status: "pending" });
    yield* orchestrator.cancelRestart;
    assert.deepEqual(yield* runs(threadId), ["starting"]);
  }).pipe(Effect.provide(layerServer(SqlitePersistence.layerMemory))),
);
