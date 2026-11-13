import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Decisions from "../../../decisions/Decisions.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Rules from "../../../rules/Rules.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

const layerServerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Bridge tools", (it) => {
  // A server's settings over one T3 home; building it again is a restart.
  const layerSettings = Settings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
  );
  const layerHome = Layer.mergeAll(
    Layer.fresh(SqlitePersistence.layerMemory),
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-objectives-test-" })),
  );
  const answeredDecision = {
    id: "garden-shed-paint",
    title: "Garden shed: which paint?",
    question: "Green or grey for the shed?",
    options: [],
    entries: [],
    revision: 3,
  };
  const firstMate: McpInvocationContext.McpInvocationContext["Service"] = {
    environmentId,
    requestNamespace: "client:firstmate",
    thread: undefined,
    client: { sessionId: "firstmate", label: "FirstMate", access: "full-access" },
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  };
  const layerToolsAs = (caller: McpInvocationContext.McpInvocationContext["Service"]) =>
    McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          layerServerEnvironment,
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Decisions.Decisions)({
            set: ({ replyTo }) =>
              replyTo === threadId
                ? Effect.succeed({
                    replyTo,
                    actions: [],
                    lastActionSeq: 0,
                    decisions: [
                      {
                        ...answeredDecision,
                        answered: {
                          commandId: CommandId.make("reply"),
                          at: "2026-11-09T00:00:00Z",
                        },
                      },
                    ],
                  })
                : Effect.fail(new Decisions.DecisionsReplyThreadError({ threadId: replyTo })),
          }),
          Layer.succeed(McpInvocationContext.McpInvocationContext, caller),
        ).pipe((dependencies) => Rules.layer.pipe(Layer.provideMerge(dependencies))),
      ),
    );
  const layerTools = layerToolsAs(firstMate);
  const setBridge = (
    tool: "t3_objectives_set" | "t3_routing_set",
    params: { markdown: string | null },
  ) =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const results = yield* toolkit.handle(tool, params).pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.result;
    });
  const saved = (field: "objectives" | "modelRouting") =>
    Settings.ServerSettingsService.pipe(
      Effect.flatMap((settings) => settings.getSettings),
      Effect.map((settings) => settings[field]),
      Effect.provide(Layer.fresh(layerSettings)),
    );

  it.effect.each([
    ["t3_objectives_set", "objectives", "- **Ship** the Bridge.", "- **Rest** on Sundays."],
    [
      "t3_routing_set",
      "modelRouting",
      "| When | Model |\n| --- | --- |\n| Review | opus |",
      "| When | Model |\n| --- | --- |\n| Docs | haiku |",
    ],
  ] as const)(
    "%s sets, replaces and clears it, saved across a restart and sent to clients",
    ([tool, field, firstMarkdown, secondMarkdown]) =>
      Effect.gen(function* () {
        const first = { markdown: firstMarkdown };
        const second = { markdown: secondMarkdown };
        // Older FirstMate builds still send objectives' retired `lastReviewed`; it must not fail.
        const staleCall = { ...first, lastReviewed: "2026-11-05" };
        yield* Effect.gen(function* () {
          const settings = yield* Settings.ServerSettingsService;
          const changes = yield* settings.subscribeChanges;
          expect(yield* setBridge(tool, staleCall)).toEqual({ [field]: first });
          // The settings stream is what every connected client's Bridge listens to.
          expect(Option.getOrThrow(yield* Stream.runHead(changes))[field]).toEqual(first);
          expect(yield* setBridge(tool, second)).toEqual({ [field]: second });
        }).pipe(Effect.provide(layerTools.pipe(Layer.provideMerge(Layer.fresh(layerSettings)))));
        expect(yield* saved(field)).toEqual(second);

        const cleared = yield* setBridge(tool, { markdown: null }).pipe(
          Effect.provide(layerTools.pipe(Layer.provideMerge(Layer.fresh(layerSettings)))),
        );
        expect(cleared).toEqual({ [field]: null });
        expect(yield* saved(field)).toBeNull();
      }).pipe(Effect.provide(layerHome)),
  );

  it.effect("t3_routing_set refuses read-only clients and other environments' credentials", () =>
    Effect.gen(function* () {
      const table = { markdown: "| When | Model |\n| --- | --- |\n| Review | opus |" };
      const readOnly = {
        ...firstMate,
        client: { sessionId: "firstmate", label: "FirstMate", access: "read-only" as const },
      };
      const elsewhere = { ...firstMate, environmentId: EnvironmentId.make("environment:other") };
      for (const caller of [readOnly, elsewhere]) {
        const result = yield* setBridge("t3_routing_set", table).pipe(
          Effect.provide(layerToolsAs(caller)),
        );
        expect(result).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* saved("modelRouting")).toBeNull();
    }).pipe(Effect.provide(layerSettings.pipe(Layer.provideMerge(layerHome)))),
  );

  it.effect(
    "t3_reports_pin and t3_reports_unpin change one report each, saved across a restart",
    () =>
      Effect.gen(function* () {
        const call = (tool: "t3_reports_pin" | "t3_reports_unpin", params: object) =>
          Effect.gen(function* () {
            const toolkit = yield* EnvironmentToolkit;
            const results = yield* toolkit
              .handle(tool, params as never)
              .pipe(Stream.unwrap, Stream.runCollect);
            return results.at(-1)?.result;
          });
        const shed = {
          id: "shed-paint",
          title: "Shed paint survey",
          summary: "Grey weathers best.",
          location: "/reports/shed-paint.md",
        };
        const fence = {
          ...shed,
          id: "fence",
          title: "Fence quotes",
          location: "https://example.com/r",
        };
        yield* Effect.gen(function* () {
          yield* call("t3_reports_pin", shed);
          yield* TestClock.adjust("1 minute");
          expect(yield* call("t3_reports_pin", fence)).toEqual({
            reports: [
              { id: "fence", title: "Fence quotes", pinnedAt: "1970-01-01T00:01:00.000Z" },
              {
                id: "shed-paint",
                title: "Shed paint survey",
                pinnedAt: "1970-01-01T00:00:00.000Z",
              },
            ],
          });
          // Pinning an id again replaces it and moves it to the top.
          yield* TestClock.adjust("1 minute");
          yield* call("t3_reports_pin", {
            ...shed,
            title: "Shed paint, final",
            night: "2026-11-11",
          });
          expect(yield* call("t3_reports_unpin", { id: "fence" })).toEqual({
            reports: [
              {
                id: "shed-paint",
                title: "Shed paint, final",
                pinnedAt: "1970-01-01T00:02:00.000Z",
                night: "2026-11-11",
              },
            ],
          });
          expect(yield* call("t3_reports_unpin", { id: "never-pinned" })).toMatchObject({
            reports: [{ id: "shed-paint" }],
          });
        }).pipe(Effect.provide(layerTools.pipe(Layer.provideMerge(Layer.fresh(layerSettings)))));
        const pinned = yield* Settings.ServerSettingsService.pipe(
          Effect.flatMap((settings) => settings.getSettings),
          Effect.map((settings) => settings.pinnedReports),
          Effect.provide(Layer.fresh(layerSettings)),
        );
        expect(pinned).toEqual({
          "shed-paint": {
            title: "Shed paint, final",
            summary: "Grey weathers best.",
            location: "/reports/shed-paint.md",
            pinnedAt: "1970-01-01T00:02:00.000Z",
            night: "2026-11-11",
          },
        });
      }).pipe(Effect.provide(layerHome)),
  );

  it.effect("t3_decisions_set answers with what was stored, and names a missing replyTo", () =>
    Effect.gen(function* () {
      const setDecisions = (replyTo: ThreadId) =>
        Effect.gen(function* () {
          const toolkit = yield* EnvironmentToolkit;
          const results = yield* toolkit
            .handle("t3_decisions_set", { replyTo, decisions: [answeredDecision] })
            .pipe(Stream.unwrap, Stream.runCollect);
          return results.at(-1)?.result;
        });
      // FirstMate checks ids and revisions against what it sent; `answered` is T3's own.
      expect(yield* setDecisions(threadId)).toEqual({
        replyTo: threadId,
        decisions: [{ id: "garden-shed-paint", revision: 3, answered: true }],
      });
      expect(yield* setDecisions(ThreadId.make("thread:gone"))).toMatchObject({
        code: "invalid_request",
        message: "replyTo thread thread:gone was not found.",
      });
    }).pipe(
      Effect.provide(
        layerTools.pipe(Layer.provideMerge(layerSettings), Layer.provideMerge(layerHome)),
      ),
    ),
  );

  it.effect("t3_rules_set answers with counts of what was stored", () =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const results = yield* toolkit
        .handle("t3_rules_set", {
          rules: [
            { id: "R001", group: "How to work", text: "Ask first.", status: "approved" },
            {
              id: "R002",
              group: "How to work",
              text: "Never push.",
              status: "pending",
              recommendation: { choice: "keep", label: "Keep" },
            },
          ],
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(results.at(-1)?.result).toEqual({ rules: 2, pending: 1, sent: [] });
    }).pipe(
      Effect.provide(
        layerTools.pipe(Layer.provideMerge(layerSettings), Layer.provideMerge(layerHome)),
      ),
    ),
  );
});

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(Decisions.Decisions)({}),
      Layer.mock(Rules.Rules)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      layerServerEnvironment,
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
