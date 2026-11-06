import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as DecisionReplyService from "./DecisionReplyService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for decision replies"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// The effect worker stays off, so a started turn stays live and later sends queue behind it.
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "decision-reply" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerTest = DecisionReplyService.layer.pipe(
  Layer.provideMerge(
    ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    ),
  ),
);

const coordinator = ThreadId.make("thread:firstmate");
const decisionThread = ThreadId.make("thread:decision");
const question = "Give the word to buy the first window-view camera?";

const setup = (options: { readonly coordinatorBusy: boolean }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const create = (threadId: ThreadId, decisionOf?: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:firstmate"),
        title: "FirstMate",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
        ...(decisionOf === undefined
          ? {}
          : {
              decisionOf,
              decision: {
                taskId: "camera-view-first-camera",
                title: "First window camera",
                question,
                options: [{ label: "Buy it" }],
                entries: [{ at: "2026-10-26T06:53:24.000Z", kind: "raised", text: "Cameras." }],
              },
            }),
      });
    yield* create(coordinator);
    yield* create(decisionThread, coordinator);
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
    return yield* DecisionReplyService.DecisionReplyService;
  });

const readThreads = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const firstmate = yield* projections.getThreadRecords(coordinator, ["messages", "runs"]);
  const decision = yield* projections.getThread(decisionThread);
  return { firstmate, decision };
});

const replyId = CommandId.make("reply:camera");

it.effect(
  "a reply queues behind FirstMate's turn and settles the decision; undo withdraws it",
  () =>
    Effect.gen(function* () {
      const replies = yield* setup({ coordinatorBusy: true });
      const sent = yield* replies.reply({
        threadId: decisionThread,
        commandId: replyId,
        text: "Buy it: one Reolink CX810.",
        revision: 1,
      });
      assert.equal(sent.coordinatorThreadId, coordinator);
      assert.equal(sent.queued, true);

      const afterSend = yield* readThreads;
      const message = afterSend.firstmate.messages.find(
        (candidate) => candidate.id === sent.messageId,
      );
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
      const run = afterSend.firstmate.runs.find((candidate) => candidate.id === sent.runId);
      assert.equal(run?.status, "queued");
      assert.equal(afterSend.decision.settledOverride, "settled");

      // A retry with the same id replays instead of sending twice.
      yield* replies.reply({
        threadId: decisionThread,
        commandId: replyId,
        text: "Buy it: one Reolink CX810.",
      });
      const afterRetry = yield* readThreads;
      assert.equal(afterRetry.firstmate.runs.length, afterSend.firstmate.runs.length);

      const undone = yield* replies.undoReply({ threadId: decisionThread, commandId: replyId });
      assert.equal(undone.withdrawn, true);
      const afterUndo = yield* readThreads;
      assert.equal(
        afterUndo.firstmate.runs.find((candidate) => candidate.id === sent.runId)?.status,
        "cancelled",
      );
      assert.equal(afterUndo.decision.settledOverride, "active");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a reply to an idle FirstMate starts its turn, so undo leaves it settled", () =>
  Effect.gen(function* () {
    const replies = yield* setup({ coordinatorBusy: false });
    const sent = yield* replies.reply({
      threadId: decisionThread,
      commandId: replyId,
      text: "Later: ask me next week.",
    });
    assert.equal(sent.queued, false);
    assert.ok(sent.runId !== null);

    const undone = yield* replies.undoReply({ threadId: decisionThread, commandId: replyId });
    assert.equal(undone.withdrawn, false);
    const { decision } = yield* readThreads;
    assert.equal(decision.settledOverride, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a reply to a decision updated since it was read sends nothing", () =>
  Effect.gen(function* () {
    const replies = yield* setup({ coordinatorBusy: true });
    const refused = yield* replies
      .reply({ threadId: decisionThread, commandId: replyId, text: "Buy it.", revision: 2 })
      .pipe(Effect.flip);
    assert.equal(refused.reason, "updated");
    const { firstmate, decision } = yield* readThreads;
    assert.equal(firstmate.runs.length, 1);
    assert.equal(decision.settledOverride, null);
  }).pipe(Effect.provide(layerTest)),
);
