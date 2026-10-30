import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const cursorInstanceId = ProviderInstanceId.make("cursor");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const threadConfigByInstance = new Map<
  ProviderInstanceId,
  OrchestrationV2ProviderCapabilities["threadConfig"]
>([
  [providerInstanceId, { environment: true, instructions: true }],
  [cursorInstanceId, { environment: false, instructions: true }],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
    orchestrationAdapter: {
      getCapabilities: () =>
        Effect.succeed({
          threadConfig: threadConfigByInstance.get(instanceId),
        } as OrchestrationV2ProviderCapabilities),
    },
  }) as unknown as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId,
          title: "Project",
          workspaceRoot: "/project-root",
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect(
    "binds the thread's environment and instructions only where the adapter applies them",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const thread = {
          ...makeThread({ now: yield* DateTime.now, worktreePath: "/worktree" }),
          environment: { FM_TASK_ID: "task-1" },
          instructions: "The launch brief is first-party.",
        };
        const resolve = (instanceId: ProviderInstanceId) =>
          policy.resolve({ thread, modelSelection: { instanceId, model: "test-model" } });

        const resolved = yield* resolve(providerInstanceId);
        assert.deepStrictEqual(resolved.environment, { FM_TASK_ID: "task-1" });
        assert.equal(resolved.instructions, "The launch brief is first-party.");

        const onCursor = yield* Effect.flip(resolve(cursorInstanceId));
        assert.equal(onCursor._tag, "RuntimePolicyThreadConfigUnsupportedError");
        assert.include(onCursor.message, "environment");
        const onGrokWithoutCapability = yield* Effect.flip(
          policy.assertThreadConfigSupported({
            providerInstanceId: grokInstanceId,
            instructions: thread.instructions,
          }),
        );
        assert.equal(onGrokWithoutCapability.field, "instructions");
        yield* policy.assertThreadConfigSupported({
          providerInstanceId: cursorInstanceId,
          instructions: thread.instructions,
        });
      }),
  );
});
