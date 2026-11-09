import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type Decision,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Decisions from "./Decisions.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for decisions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// The effect worker stays off, so a started turn stays live and later sends queue behind it.
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "decisions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
// One T3 home with its threads; building `Decisions.layer` over it again is a restart.
const layerHome = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
  ),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-decisions-test-" }),
);
const started = <A, E, R>(
  use: (decisions: Decisions.Decisions["Service"]) => Effect.Effect<A, E, R>,
) => Decisions.Decisions.pipe(Effect.flatMap(use), Effect.provide(Layer.fresh(Decisions.layer)));

const coordinator = ThreadId.make("thread:firstmate");
const question = "Give the word to buy the first window-view camera?";
const camera: Decision = {
  id: "camera-view-first-camera",
  title: "First window camera",
  question,
  options: [{ label: "Buy it" }],
  entries: [{ at: "2026-10-26T06:53:24.000Z", kind: "raised", text: "Cameras." }],
  revision: 1,
};
const shed: Decision = {
  id: "garden-shed-paint",
  title: "Garden shed: which paint?",
  question: "Green or grey for the shed?",
  options: [],
  entries: [{ at: "2026-11-01T00:00:00.000Z", kind: "raised", text: "Two paints fit." }],
  revision: 1,
  wakeAt: "2026-11-12T00:00:00.000Z",
};

const setup = (options: { readonly coordinatorBusy: boolean }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:firstmate"),
      threadId: coordinator,
      projectId: ProjectId.make("project:firstmate"),
      title: "FirstMate",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
    });
    if (options.coordinatorBusy) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("firstmate:busy"),
        threadId: coordinator,
        messageId: MessageId.make("firstmate:busy"),
        text: "Check why the friend-map build is slow",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    }
  });

const firstmateChat = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return yield* projections.getThreadRecords(coordinator, ["messages", "runs"]);
});
const current = (decisions: Decisions.Decisions["Service"]) =>
  Stream.runHead(decisions.changes).pipe(Effect.map(Option.getOrThrow));
const answered = (decisions: Decisions.Decisions["Service"], id: string) =>
  current(decisions).pipe(
    Effect.map((state) => state.decisions.find((decision) => decision.id === id)?.answered),
  );

const replyId = CommandId.make("reply:camera");

it.layer(NodeServices.layer)("Decisions", (it) => {
  it.effect(
    "keeps the list FirstMate sends, across a restart, and ignores the same list twice",
    () =>
      Effect.gen(function* () {
        yield* setup({ coordinatorBusy: false });
        yield* started((decisions) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* current(decisions), { replyTo: null, decisions: [] });
            const first = yield* decisions.set({ replyTo: coordinator, decisions: [camera, shed] });
            assert.deepEqual(first, { replyTo: coordinator, decisions: [camera, shed] });
            // FirstMate sends the list on every change of its own records; a repeat is no change.
            assert.strictEqual(
              yield* decisions.set({ replyTo: coordinator, decisions: [camera, shed] }),
              first,
            );
            const missing = yield* decisions
              .set({ replyTo: ThreadId.make("thread:gone"), decisions: [] })
              .pipe(Effect.flip);
            assert.equal(missing._tag, "DecisionsReplyThreadError");
          }),
        );
        const afterRestart = yield* started(current);
        assert.deepEqual(afterRestart, { replyTo: coordinator, decisions: [camera, shed] });
        // A decision left out of the next list is gone.
        const dropped = yield* started((decisions) =>
          decisions.set({ replyTo: coordinator, decisions: [shed] }),
        );
        assert.deepEqual(
          dropped.decisions.map((decision) => decision.id),
          [shed.id],
        );
      }).pipe(Effect.provide(layerHome)),
  );

  it.effect(
    "a reply queues behind FirstMate's turn and takes the decision off the list; undo brings it back",
    () =>
      Effect.gen(function* () {
        yield* setup({ coordinatorBusy: true });
        yield* started((decisions) =>
          Effect.gen(function* () {
            yield* decisions.set({ replyTo: coordinator, decisions: [camera] });
            const sent = yield* decisions.reply({
              decisionId: camera.id,
              commandId: replyId,
              text: "Buy it: one Reolink CX810.",
              revision: 1,
            });
            assert.equal(sent.coordinatorThreadId, coordinator);
            assert.equal(sent.queued, true);

            const afterSend = yield* firstmateChat;
            const message = afterSend.messages.find((candidate) => candidate.id === sent.messageId);
            assert.ok(message !== undefined);
            assert.equal(message.role, "user");
            // FirstMate reads the task id from its own line, under a header naming the decision.
            assert.equal(
              message.text,
              [
                "**Decision · First window camera**",
                "needs-me-task: camera-view-first-camera",
                "",
                `> ${question}`,
                "",
                "Buy it: one Reolink CX810.",
              ].join("\n"),
            );
            assert.equal(
              afterSend.runs.find((candidate) => candidate.id === sent.runId)?.status,
              "queued",
            );
            assert.equal((yield* answered(decisions, camera.id))?.commandId, replyId);
            // The same list again keeps the answer; FirstMate has not acted on it yet.
            yield* decisions.set({ replyTo: coordinator, decisions: [camera] });
            assert.ok((yield* answered(decisions, camera.id)) !== undefined);

            // A retry with the same id replays instead of sending twice.
            yield* decisions.reply({
              decisionId: camera.id,
              commandId: replyId,
              text: "Buy it: one Reolink CX810.",
            });
            assert.equal((yield* firstmateChat).runs.length, afterSend.runs.length);

            const undone = yield* decisions.undoReply({
              decisionId: camera.id,
              commandId: replyId,
            });
            assert.equal(undone.withdrawn, true);
            assert.equal(
              (yield* firstmateChat).runs.find((candidate) => candidate.id === sent.runId)?.status,
              "cancelled",
            );
            assert.equal(yield* answered(decisions, camera.id), undefined);
          }),
        );
      }).pipe(Effect.provide(layerHome)),
  );

  it.effect(
    "a reply to an idle FirstMate starts its turn, so undo leaves it answered until FirstMate changes the decision",
    () =>
      Effect.gen(function* () {
        yield* setup({ coordinatorBusy: false });
        yield* started((decisions) =>
          Effect.gen(function* () {
            yield* decisions.set({ replyTo: coordinator, decisions: [camera] });
            const sent = yield* decisions.reply({
              decisionId: camera.id,
              commandId: replyId,
              text: "Later: ask me next week.",
            });
            assert.equal(sent.queued, false);
            assert.ok(sent.runId !== null);

            const undone = yield* decisions.undoReply({
              decisionId: camera.id,
              commandId: replyId,
            });
            assert.equal(undone.withdrawn, false);
            assert.ok((yield* answered(decisions, camera.id)) !== undefined);

            // FirstMate defers it to a date: a changed decision shows again, under Scheduled.
            const deferred = { ...camera, wakeAt: "2026-11-17T00:00:00.000Z" };
            yield* decisions.set({ replyTo: coordinator, decisions: [deferred] });
            assert.deepEqual((yield* current(decisions)).decisions, [deferred]);
          }),
        );
      }).pipe(Effect.provide(layerHome)),
  );

  it.effect(
    "a reply to a decision updated since it was read, or no longer listed, sends nothing",
    () =>
      Effect.gen(function* () {
        yield* setup({ coordinatorBusy: true });
        yield* started((decisions) =>
          Effect.gen(function* () {
            yield* decisions.set({ replyTo: coordinator, decisions: [{ ...camera, revision: 2 }] });
            const stale = yield* decisions
              .reply({ decisionId: camera.id, commandId: replyId, text: "Buy it.", revision: 1 })
              .pipe(Effect.flip);
            assert.equal(stale.reason, "updated");
            const gone = yield* decisions
              .reply({ decisionId: shed.id, commandId: replyId, text: "Green.", revision: 1 })
              .pipe(Effect.flip);
            assert.equal(gone.reason, "not-found");
            assert.equal((yield* firstmateChat).runs.length, 1);
            assert.equal(yield* answered(decisions, camera.id), undefined);
          }),
        );
      }).pipe(Effect.provide(layerHome)),
  );
});
