import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
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

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
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

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("t3_objectives_set", (it) => {
  // A server's settings over one T3 home; building it again is a restart.
  const layerSettings = Settings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
  );
  const layerHome = Layer.mergeAll(
    Layer.fresh(SqlitePersistence.layerMemory),
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-objectives-test-" })),
  );
  const layerTools = McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        layerServerEnvironment,
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "client:firstmate",
          thread: undefined,
          client: { sessionId: "firstmate", label: "FirstMate", access: "full-access" },
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
      ),
    ),
  );
  const setObjectives = (params: { markdown: string | null }) =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const results = yield* toolkit
        .handle("t3_objectives_set", params)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.result;
    });
  const savedObjectives = Settings.ServerSettingsService.pipe(
    Effect.flatMap((settings) => settings.getSettings),
    Effect.map((settings) => settings.objectives),
    Effect.provide(Layer.fresh(layerSettings)),
  );

  it.effect("sets, replaces and clears them, saved across a restart and sent to clients", () =>
    Effect.gen(function* () {
      const first = { markdown: "- **Ship** the Bridge." };
      const second = { markdown: "- **Rest** on Sundays." };
      // Older FirstMate builds still send the retired `lastReviewed`; the call must not fail.
      const staleCall = { ...first, lastReviewed: "2026-11-05" };
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const changes = yield* settings.subscribeChanges;
        expect(yield* setObjectives(staleCall)).toEqual({ objectives: first });
        // The settings stream is what every connected client's Bridge listens to.
        expect(Option.getOrThrow(yield* Stream.runHead(changes)).objectives).toEqual(first);
        expect(yield* setObjectives(second)).toEqual({ objectives: second });
      }).pipe(Effect.provide(layerTools.pipe(Layer.provideMerge(Layer.fresh(layerSettings)))));
      expect(yield* savedObjectives).toEqual(second);

      const cleared = yield* setObjectives({ markdown: null }).pipe(
        Effect.provide(layerTools.pipe(Layer.provideMerge(Layer.fresh(layerSettings)))),
      );
      expect(cleared).toEqual({ objectives: null });
      expect(yield* savedObjectives).toBeNull();
    }).pipe(Effect.provide(layerHome)),
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
