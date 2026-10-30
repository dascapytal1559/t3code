import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export class RuntimePolicyThreadConfigUnsupportedError extends Schema.TaggedError<RuntimePolicyThreadConfigUnsupportedError>()(
  "RuntimePolicyThreadConfigUnsupportedError",
  {
    providerInstanceId: ProviderInstanceId,
    field: Schema.Literals(["environment", "instructions"]),
  },
) {
  override get message(): string {
    return `Provider instance ${this.providerInstanceId} cannot apply a thread's ${this.field}. Pick a provider that orchestrator_capabilities lists with thread${this.field === "environment" ? "Environment" : "Instructions"}: true.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyThreadConfigUnsupportedError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
  /** Refuses a thread environment or instructions the instance's adapter would not apply. */
  readonly assertThreadConfigSupported: (
    input: Pick<OrchestrationV2AppThread, "environment" | "instructions"> & {
      readonly providerInstanceId: ProviderInstanceId;
    },
  ) => Effect.Effect<void, RuntimePolicyThreadConfigUnsupportedError>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

const threadConfigOf = (thread: OrchestrationV2AppThread) => ({
  ...(thread.environment === undefined ? {} : { environment: thread.environment }),
  ...(thread.instructions === undefined ? {} : { instructions: thread.instructions }),
});

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
      ...threadConfigOf(input.thread),
    });
  }),
  assertThreadConfigSupported: Effect.fn("RuntimePolicyV2.assertThreadConfigSupported")(
    function () {
      return Effect.void;
    },
  ),
});

/** The mode an instance actually runs: one it does not list falls back to approval-required. */
export function effectiveRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const assertThreadConfigSupported: RuntimePolicyV2Shape["assertThreadConfigSupported"] =
      Effect.fn("RuntimePolicyV2.assertThreadConfigSupported")(function* (input) {
        if (input.environment === undefined && input.instructions === undefined) return;
        const instance = yield* providerInstances.getInstance(input.providerInstanceId);
        const supported =
          instance === undefined
            ? undefined
            : (yield* instance.orchestrationAdapter
                .getCapabilities()
                .pipe(Effect.orElseSucceed(() => undefined)))?.threadConfig;
        const field =
          input.environment !== undefined && supported?.environment !== true
            ? "environment"
            : input.instructions !== undefined && supported?.instructions !== true
              ? "instructions"
              : undefined;
        if (field !== undefined)
          return yield* new RuntimePolicyThreadConfigUnsupportedError({
            providerInstanceId: input.providerInstanceId,
            field,
          });
      });
    return RuntimePolicyV2.of({
      assertThreadConfigSupported,
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        // A provider switch or fork can move a thread onto an adapter that would drop these.
        yield* assertThreadConfigSupported({
          ...threadConfigOf(input.thread),
          providerInstanceId: input.modelSelection.instanceId,
        });
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: effectiveRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...threadConfigOf(input.thread),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        assertThreadConfigSupported: base.assertThreadConfigSupported,
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
