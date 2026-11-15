import {
  OrchestratorMcpFailure,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as UsageClaims from "../../../usage/UsageClaims.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable, verifyCause } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
const restartStatus = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.restartStatus.pipe(Effect.mapError(unavailable));
});
const updateSettings = Effect.fn("EnvironmentMcp.updateSettings")(function* <E, R>(
  patch: ServerSettingsPatch,
  check: Effect.Effect<unknown, E, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const update = Effect.gen(function* () {
    // The turn may have ended, or the thread's modes changed, while this waited for the lock.
    yield* check;
    const { settings } = yield* access;
    return yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable));
  });
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    updateSettings(patch, check).pipe(Effect.map(preferences)),
  ),
  t3_objectives_set: McpToolAccess.writesEnvironment(({ markdown }, check) =>
    updateSettings({ objectives: markdown === null ? null : { markdown } }, check).pipe(
      Effect.map(({ objectives }) => ({ objectives })),
    ),
  ),
  t3_routing_set: McpToolAccess.writesEnvironment(({ markdown }, check) =>
    updateSettings({ modelRouting: markdown === null ? null : { markdown } }, check).pipe(
      Effect.map(({ modelRouting }) => ({ modelRouting })),
    ),
  ),
  // These take no thread lock: holding queues locks every thread, the caller's among them.
  t3_restart_request: McpToolAccess.writesEnvironment(({ reason, causedBy }) =>
    Effect.gen(function* () {
      const { scope, caller, threads } = yield* access;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.requestRestart({
        reason,
        requestedBy: caller?.title ?? scope.client?.label ?? "MCP",
        causedBy: causedBy === undefined ? undefined : yield* verifyCause(threads, causedBy),
      });
      return yield* restartStatus;
    }),
  ),
  t3_restart_status: McpToolAccess.reads(() => access.pipe(Effect.andThen(restartStatus))),
  t3_restart_cancel: McpToolAccess.writesEnvironment(() =>
    Effect.gen(function* () {
      yield* access;
      yield* (yield* Orchestrator.OrchestratorV2).cancelRestart;
      return yield* restartStatus;
    }),
  ),
  t3_usage_claim: McpToolAccess.writesEnvironment(
    ({ sessionId, directory, threadId, runId, causedBy, device }) =>
      Effect.gen(function* () {
        const { threads } = yield* access;
        const path = yield* Path.Path;
        const targets: UsageClaims.UsageClaimTarget[] = [
          ...(sessionId === undefined ? [] : [{ kind: "session" as const, sessionId }]),
          ...(directory === undefined ? [] : [{ kind: "directory" as const, directory }]),
          ...(runId === undefined ? [] : [{ kind: "run" as const, runId }]),
        ];
        const target = targets.length === 1 ? targets[0]! : undefined;
        if (target === undefined)
          return yield* invalidRequest("Give exactly one of sessionId, directory or runId.");
        if ((target.kind === "run") !== (threadId !== undefined))
          return yield* invalidRequest("threadId goes with runId, and only with runId.");
        if (target.kind === "directory" && !path.isAbsolute(target.directory))
          return yield* invalidRequest("directory must be an absolute path.");
        if ((causedBy === undefined) === (device === undefined) || (causedBy === null && device))
          return yield* invalidRequest("Give exactly one of causedBy or device.");
        if (runId !== undefined && threadId !== undefined) {
          const { runs } = yield* threads
            .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
            .pipe(Effect.mapError(unavailable));
          if (!runs.some((run) => run.id === runId))
            return yield* invalidRequest(`run ${runId} is not a run of thread ${threadId}.`);
        }
        const value: UsageClaims.UsageClaimValue | null =
          device !== undefined
            ? { device }
            : causedBy === null || causedBy === undefined
              ? null
              : { causedBy: yield* verifyCause(threads, causedBy) };
        const claimed = yield* (yield* UsageClaims.UsageClaims)
          .claim({ target, value })
          .pipe(Effect.mapError(unavailable));
        return {
          ...(claimed.target.kind === "session"
            ? { sessionId: claimed.target.sessionId }
            : claimed.target.kind === "directory"
              ? { directory: claimed.target.directory }
              : { threadId, runId }),
          causedBy:
            claimed.value !== null && "causedBy" in claimed.value ? claimed.value.causedBy : null,
          device: claimed.value !== null && "device" in claimed.value ? claimed.value.device : null,
        };
      }),
  ),
});
