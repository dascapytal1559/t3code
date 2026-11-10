import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type Rule,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Decisions from "../decisions/Decisions.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Rules from "./Rules.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for rules"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "rules" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerHome = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
  ),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-rules-test-" }),
);
// Building the layers over the same home again is a restart.
const started = <A, E, R>(
  use: (
    rules: Rules.Rules["Service"],
    decisions: Decisions.Decisions["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.all([Rules.Rules, Decisions.Decisions]).pipe(
    Effect.flatMap(([rules, decisions]) => use(rules, decisions)),
    Effect.provide(Layer.fresh(Rules.layer.pipe(Layer.provideMerge(Decisions.layer)))),
  );

const coordinator = ThreadId.make("thread:firstmate");
const approved: Rule = {
  id: "R001",
  group: "FirstMate · How to work",
  source: "rules/how-to-work.md",
  text: "Ask before deleting anything.",
  status: "approved",
  approvedOn: "2026-11-01",
};
const pending: Rule = {
  id: "R010",
  group: "FirstMate · How to work",
  text: "Always run the full test suite before reporting done.",
  status: "pending",
  recommendation: {
    choice: "keep-narrower",
    label: "Keep narrower",
    note: "The full suite is slow; the touched tests are enough.",
    proposedText: "Run the tests your change touches before reporting done.",
  },
};

const createCoordinator = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:firstmate"),
    threadId: coordinator,
    projectId: ProjectId.make("project:firstmate"),
    title: "FirstMate",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "mcp",
  });
});
const current = (rules: Rules.Rules["Service"]) =>
  Stream.runHead(rules.changes).pipe(Effect.map(Option.getOrThrow));
const firstmateMessages = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return (yield* projections.getThreadRecords(coordinator, ["messages"])).messages;
});
const answerId = CommandId.make("answer:R010");

it.layer(NodeServices.layer)("Rules", (it) => {
  it.effect("keeps the list FirstMate sends, across a restart, and ignores the same list", () =>
    Effect.gen(function* () {
      yield* started((rules) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* current(rules), { rules: [], sent: [] });
          const first = yield* rules.set({ rules: [approved, pending] });
          assert.deepEqual(first, { rules: [approved, pending], sent: [] });
          assert.strictEqual(yield* rules.set({ rules: [approved, pending] }), first);
        }),
      );
      assert.deepEqual(yield* started(current), { rules: [approved, pending], sent: [] });
      const cleared = yield* started((rules) => rules.set({ rules: [] }));
      assert.deepEqual(cleared, { rules: [], sent: [] });
    }).pipe(Effect.provide(layerHome)),
  );

  it.effect(
    "agreeing sends FirstMate one message and marks the rule sent until FirstMate changes it",
    () =>
      Effect.gen(function* () {
        yield* createCoordinator;
        yield* started((rules, decisions) =>
          Effect.gen(function* () {
            yield* decisions.set({ replyTo: coordinator, decisions: [] });
            yield* rules.set({ rules: [approved, pending] });
            const sent = yield* rules.answer({
              ruleId: pending.id,
              recommendation: pending.recommendation,
              commandId: answerId,
            });
            assert.equal(sent.coordinatorThreadId, coordinator);
            const message = (yield* firstmateMessages).find(
              (candidate) => candidate.id === sent.messageId,
            );
            assert.equal(message?.role, "user");
            assert.equal(
              message?.text,
              [
                "Agree with your recommendation on rule R010: Keep narrower.",
                "rule-answer: R010 keep-narrower",
              ].join("\n"),
            );
            assert.deepEqual((yield* current(rules)).sent, [pending.id]);

            // A retry replays rather than sending twice.
            yield* rules.answer({
              ruleId: pending.id,
              recommendation: pending.recommendation,
              commandId: answerId,
            });
            assert.equal((yield* firstmateMessages).length, 1);

            // The same list keeps it sent; FirstMate approving the rule replaces it.
            yield* rules.set({ rules: [approved, pending] });
            assert.deepEqual((yield* current(rules)).sent, [pending.id]);
            const nowApproved: Rule = {
              id: pending.id,
              group: pending.group,
              text: pending.recommendation.proposedText ?? pending.text,
              status: "approved",
              approvedOn: "2026-11-10",
            };
            yield* rules.set({ rules: [approved, nowApproved] });
            assert.deepEqual((yield* current(rules)).sent, []);
          }),
        );
      }).pipe(Effect.provide(layerHome)),
  );

  it.effect("refuses an answer to a changed, approved or unknown rule, or with no chat", () =>
    Effect.gen(function* () {
      yield* createCoordinator;
      yield* started((rules, decisions) =>
        Effect.gen(function* () {
          yield* rules.set({ rules: [approved, pending] });
          const answer = (ruleId: string, choice: "keep" | "keep-narrower") =>
            rules
              .answer({
                ruleId,
                recommendation: { ...pending.recommendation, choice },
                commandId: answerId,
              })
              .pipe(
                Effect.flip,
                Effect.map((error) => error.reason),
              );
          // FirstMate has named no chat yet.
          assert.equal(yield* answer(pending.id, "keep-narrower"), "no-coordinator");
          yield* decisions.set({ replyTo: coordinator, decisions: [] });
          assert.equal(yield* answer(pending.id, "keep"), "updated");
          assert.equal(yield* answer(approved.id, "keep"), "not-found");
          assert.equal(yield* answer("R999", "keep"), "not-found");
          assert.equal((yield* firstmateMessages).length, 0);
          assert.deepEqual((yield* current(rules)).sent, []);
        }),
      );
    }).pipe(Effect.provide(layerHome)),
  );
});
