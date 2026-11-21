import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  UsageDay,
  UsageReadError,
  type OrchestrationV2ThreadShell,
  type UsageOriginReason,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageClaims from "../../../usage/UsageClaims.ts";
import * as UsageLabels from "../../../usage/UsageLabels.ts";
import * as UsageOrigins from "../../../usage/UsageOrigins.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const wakeRun = RunId.make("run:wake");
const phoneTask = ThreadId.make("thread:phone-task");
const lostTask = ThreadId.make("thread:lost-task");
const decodeUsageDay = Schema.decodeSync(UsageDay);

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
          Layer.succeed(McpInvocationContext.McpInvocationContext, caller),
        ),
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

it.effect(
  "t3_usage_reasons reads the window in the asked zone, totals what counts by default, and fails loudly",
  () =>
    Effect.gen(function* () {
      const windows: unknown[] = [];
      const row = (reason: UsageOriginReason, tokens: number, byDefault: boolean) => ({
        origin: "computer" as const,
        reason,
        byDefault,
        provider: "claude" as const,
        tokens,
        costUsd: 0,
        records: 1,
      });
      const layerUsage = Layer.mock(UsageService.UsageService)({
        readOriginReasons: (window) =>
          window.untilDay === "2026-01-01"
            ? Effect.fail(
                new UsageReadError({
                  reason: "scanFailed",
                  detail: "Could not read the origins of T3 prompts.",
                }),
              )
            : Effect.sync(() => {
                windows.push(window);
                return [row("upkeep", 10, false), row("unregisteredSession", 30, true)];
              }),
      });
      const reasons = ({
        untilDay,
        ...params
      }: {
        readonly days?: number;
        readonly untilDay?: string;
        readonly timeZone?: string;
      }) =>
        Effect.gen(function* () {
          const toolkit = yield* EnvironmentToolkit;
          const window =
            untilDay === undefined ? params : { ...params, untilDay: decodeUsageDay(untilDay) };
          return yield* toolkit.handle("t3_usage_reasons", window).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((results) => results.at(-1)?.result),
          );
        }).pipe(Effect.provide(layerUsage));

      expect(
        yield* reasons({ days: 3, untilDay: "2026-11-16", timeZone: "Australia/Sydney" }),
      ).toEqual({
        sinceDay: "2026-11-14",
        untilDay: "2026-11-16",
        timeZone: "Australia/Sydney",
        tokens: 40,
        byDefaultTokens: 30,
        rows: [row("unregisteredSession", 30, true), row("upkeep", 10, false)],
      });
      // Today is the zone's own date: already the 17th in Auckland.
      yield* TestClock.setTime(Date.parse("2026-11-16T12:00:00Z"));
      yield* reasons({ timeZone: "Pacific/Auckland" });
      expect(windows.at(-1)).toEqual({
        sinceDay: "2026-11-11",
        untilDay: "2026-11-17",
        timeZone: "Pacific/Auckland",
      });
      expect(yield* reasons({ timeZone: "Mars/Olympus" })).toMatchObject({
        code: "invalid_request",
      });
      // A watchdog must not read an unreadable window as zero.
      expect(yield* reasons({ untilDay: "2026-01-01", timeZone: "UTC" })).toMatchObject({
        code: "orchestration_error",
        message: expect.stringContaining("Could not read the origins"),
      });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadCommandExecutor.layer,
              layerServerEnvironment,
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              Layer.mock(Settings.ServerSettingsService)({}),
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
          Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
        ),
      ),
    ),
);

it.effect(
  "t3_usage_claim takes exactly one target and one real cause or device, and removes a claim",
  () => {
    const renamedRuns: string[] = [];
    return Effect.gen(function* () {
      const claims = yield* UsageClaims.UsageClaims;
      const toolkit = yield* EnvironmentToolkit;
      const claim = (params: {
        readonly sessionId?: string;
        readonly from?: string;
        readonly directory?: string;
        readonly threadId?: ThreadId;
        readonly runId?: RunId;
        readonly causedBy?: { readonly threadId: ThreadId; readonly messageId: MessageId } | null;
        readonly fromThread?: { readonly threadId: ThreadId };
        readonly device?: "phone" | "computer";
        readonly ifUnclaimed?: boolean;
      }) =>
        toolkit.handle("t3_usage_claim", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((results) => results.at(-1)?.result),
        );
      const madeUp = {
        threadId: ThreadId.make("thread:made-up"),
        messageId: MessageId.make("message:made-up"),
      };

      for (const [params, refusal] of [
        [{ causedBy: madeUp }, "exactly one"],
        [{ sessionId: "pipeline", directory: "/runs/one", causedBy: madeUp }, "exactly one"],
        [{ directory: "runs/one", causedBy: madeUp }, "absolute"],
        [{ sessionId: "pipeline", causedBy: madeUp }, "causedBy"],
        [{ sessionId: "pipeline" }, "exactly one of causedBy, fromThread or device"],
        [{ sessionId: "pipeline", fromThread: { threadId: madeUp.threadId } }, "was not found"],
        [{ sessionId: "pipeline", fromThread: { threadId: lostTask } }, "counts to no device"],
        [{ sessionId: "pipeline", causedBy: madeUp, device: "phone" }, "exactly one of causedBy"],
        [{ runId: wakeRun, device: "computer" }, "threadId goes with runId"],
        [{ sessionId: "pipeline", threadId, device: "computer" }, "threadId goes with runId"],
        [{ threadId, runId: RunId.make("run:elsewhere"), device: "computer" }, "not a run of"],
        [{ sessionId: "pipeline", from: "after lunch", device: "computer" }, "ISO 8601"],
        [{ directory: "/runs/one", from: "2026-11-16T00:00:00Z", device: "computer" }, "from goes"],
        [{ threadId, runId: wakeRun, causedBy: null, ifUnclaimed: true }, "not a removal"],
      ] as const) {
        expect(yield* claim(params)).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining(refusal),
        });
      }
      expect(yield* claims.read).toEqual([]);

      // A turn with no cause, claimed straight to a device (a voice journal's wake); a later
      // drain's claim, made only if unclaimed, keeps it.
      const journal = { threadId, runId: wakeRun, causedBy: null, device: "phone" } as const;
      expect(
        yield* claim({ threadId, runId: wakeRun, device: "phone", ifUnclaimed: true }),
      ).toEqual(journal);
      expect(
        yield* claim({ threadId, runId: wakeRun, device: "computer", ifUnclaimed: true }),
      ).toEqual({ ...journal, kept: true });
      expect(yield* claims.read).toEqual([
        { kind: "run", target: wakeRun, causeMessageId: null, device: "phone" },
      ]);
      yield* claim({ threadId, runId: wakeRun, causedBy: null });

      // The drain names the task: its own turn running now counts where the task's work counts,
      // bound by value.
      expect(yield* claim({ threadId, fromThread: { threadId: phoneTask } })).toEqual({
        threadId,
        runId: wakeRun,
        causedBy: null,
        device: "phone",
        reason: "inherited",
      });
      expect(yield* claim({ threadId: lostTask, device: "computer" })).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("no turn running now"),
      });
      expect(yield* claims.read).toEqual([
        {
          kind: "run",
          target: wakeRun,
          causeMessageId: null,
          device: "phone",
          bound: { basis: "stamp", reason: "inherited", boundAt: "1970-01-01T00:00:00.000Z" },
        },
      ]);
      yield* claim({ threadId, runId: wakeRun, causedBy: null });
      // Every change to the running turn's claim rewrites its born labels, removals too; a kept
      // claim changes nothing.
      expect(renamedRuns).toEqual([wakeRun, wakeRun, wakeRun, wakeRun]);

      const prompt = { threadId, messageId: MessageId.make("message:prompt") };
      yield* claims.claim({
        target: { kind: "session", sessionId: "pipeline" },
        value: { causedBy: prompt },
      });
      expect(
        yield* claim({ sessionId: "pipeline", device: "computer", ifUnclaimed: true }),
      ).toEqual({ sessionId: "pipeline", causedBy: prompt, device: null, kept: true });
      // A kept claim needs no value, so a task that counts to no device does not refuse it.
      expect(
        yield* claim({
          sessionId: "pipeline",
          fromThread: { threadId: lostTask },
          ifUnclaimed: true,
        }),
      ).toEqual({ sessionId: "pipeline", causedBy: prompt, device: null, kept: true });
      expect(yield* claim({ sessionId: "pipeline", causedBy: null })).toEqual({
        sessionId: "pipeline",
        causedBy: null,
        device: null,
      });
      expect(yield* claims.read).toEqual([]);

      // A session resumed for other work, claimed from that work's start.
      expect(
        yield* claim({ sessionId: "engine", from: "2026-11-16T12:00:00+11:00", device: "phone" }),
      ).toEqual({
        sessionId: "engine",
        from: "2026-11-16T01:00:00.000Z",
        causedBy: null,
        device: "phone",
      });
      expect(yield* claims.read).toEqual([
        {
          kind: "session",
          target: "engine",
          fromMs: Date.parse("2026-11-16T01:00:00Z"),
          causeMessageId: null,
          device: "phone",
        },
      ]);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadCommandExecutor.layer,
              layerServerEnvironment,
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: (id) =>
                  Effect.succeed(
                    id === phoneTask || id === lostTask ? ({ deletedAt: null } as never) : null,
                  ),
                getThreadRecords: (_threadId, _fields, filter) =>
                  Effect.succeed({
                    runs: (filter?.runIds ?? []).flatMap((id) => (id === wakeRun ? [{ id }] : [])),
                  } as never),
              }),
              Layer.mock(Settings.ServerSettingsService)({}),
              Layer.mock(UsageLabels.UsageLabels)({
                named: (runId) =>
                  Effect.sync(() => {
                    renamedRuns.push(runId);
                    return "written" as const;
                  }),
              }),
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
          Layer.provideMerge(UsageClaims.layer),
          Layer.provideMerge(
            Layer.mock(UsageOrigins.UsageOrigins)({
              originAt: (id) =>
                Effect.succeed({
                  key:
                    id === phoneTask
                      ? { origin: "phone", basis: "stamp", reason: "typed" }
                      : { origin: "unknown", basis: "default", reason: "noCause" },
                  reroots: false,
                  runId: id === threadId ? wakeRun : null,
                  atMs: 0,
                }),
            }),
          ),
          Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
        ),
      ),
    );
  },
);

it.effect("t3_restart_request counts its note where the calling thread's turn counts", () =>
  Effect.gen(function* () {
    const requests: Array<Parameters<Orchestrator.OrchestratorV2["Service"]["requestRestart"]>[0]> =
      [];
    const key = { origin: "phone", basis: "stamp", reason: "inherited" } as const;
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      layerServerEnvironment,
      Layer.mock(Orchestrator.OrchestratorV2)({
        requestRestart: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return { ...request, requestedAt: "1970-01-01T00:00:00.000Z" };
          }),
        restartStatus: Effect.succeed({
          pending: true,
          reason: "install build",
          requestedAt: "1970-01-01T00:00:00.000Z",
          activeTurns: 1,
          drained: false,
          serverStartedAt: "1970-01-01T00:00:00.000Z",
        }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(phoneTask)),
      }),
      Layer.mock(Settings.ServerSettingsService)({}),
      Layer.mock(UsageOrigins.UsageOrigins)({
        originAt: (_thread, atMs) => Effect.succeed({ key, reroots: false, runId: null, atMs }),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:worker",
        thread: {
          threadId: phoneTask,
          providerSessionId: "provider:worker",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      yield* toolkit
        .handle("t3_restart_request", { reason: "install build" })
        .pipe(Stream.unwrap, Stream.runDrain);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
    expect(requests.map((request) => request.usageOrigin)).toEqual([
      UsageOrigins.storedOrigin(key, 0),
    ]);
  }),
);
