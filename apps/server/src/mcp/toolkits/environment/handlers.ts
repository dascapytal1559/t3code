import {
  OrchestratorMcpFailure,
  type OrchestratorMcpFromThread,
  RunId,
  type ServerSettings,
  type ThreadId,
  type ServerSettingsPatch,
  UsageDay,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as UsageClaims from "../../../usage/UsageClaims.ts";
import * as UsageOrigins from "../../../usage/UsageOrigins.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { bindUsageOrigin, readCaller, unavailable, verifyCause } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const decodeUsageDay = Schema.decodeSync(UsageDay);

/** The run of the thread's turn running now, or ended up to five minutes ago. */
const runningTurn = Effect.fn("mcp.usageClaimRunningTurn")(function* (threadId: ThreadId) {
  const origins = yield* UsageOrigins.UsageOrigins;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const bound = yield* origins.originAt(threadId, nowMs).pipe(Effect.mapError(unavailable));
  if (bound === null) return yield* invalidRequest(`thread ${threadId} was not found.`);
  if (bound.runId === null)
    return yield* invalidRequest(`thread ${threadId} has no turn running now.`);
  return RunId.make(bound.runId);
});

/** A claim on where a task's thread counts its work now (or at `at`), bound by value. */
const boundClaim = Effect.fn("mcp.boundUsageClaim")(function* (
  threads: Parameters<typeof bindUsageOrigin>[0],
  fromThread: OrchestratorMcpFromThread,
) {
  // Any caller may name a task's thread: the claim is about the work, not the caller's turn.
  const bound = yield* bindUsageOrigin(threads, fromThread, undefined);
  if (bound === null) return yield* unavailable();
  const stored = UsageOrigins.storedOrigin(bound.key);
  if (stored === undefined)
    return yield* invalidRequest(
      `fromThread: thread ${fromThread.threadId}'s work counts to no device then; nothing was claimed.`,
    );
  const { origin, ...binding } = stored;
  return { device: origin, bound: binding } satisfies UsageClaims.UsageClaimValue;
});

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
  t3_restart_request: McpToolAccess.writesEnvironment(({ reason, causedBy, fromThread }) =>
    Effect.gen(function* () {
      const { scope, caller, threads } = yield* access;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // The note and continuations count where the work it installs counts.
      const bound =
        fromThread === undefined ? null : yield* bindUsageOrigin(threads, fromThread, caller?.id);
      yield* orchestrator.requestRestart({
        reason,
        requestedBy: caller?.title ?? scope.client?.label ?? "MCP",
        causedBy: causedBy === undefined ? undefined : yield* verifyCause(threads, causedBy),
        usageOrigin: bound === null ? undefined : UsageOrigins.storedOrigin(bound.key),
      });
      return yield* restartStatus;
    }),
  ),
  t3_restart_status: McpToolAccess.reads(() => access.pipe(Effect.andThen(restartStatus))),
  t3_usage_reasons: McpToolAccess.reads(({ days = 7, untilDay, timeZone }) =>
    Effect.gen(function* () {
      yield* access;
      const zoneId = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const zone = DateTime.zoneMakeNamed(zoneId);
      if (Option.isNone(zone)) {
        return yield* invalidRequest(`timeZone ${zoneId} is not an IANA time zone.`);
      }
      const lastDay =
        untilDay ??
        decodeUsageDay(DateTime.formatIsoDate(DateTime.setZone(yield* DateTime.now, zone.value)));
      const sinceDay = decodeUsageDay(
        DateTime.formatIsoDateUtc(
          DateTime.subtract(DateTime.makeUnsafe(`${lastDay}T00:00:00Z`), { days: days - 1 }),
        ),
      );
      const rows = yield* (yield* UsageService.UsageService)
        .readOriginReasons({ sinceDay, untilDay: lastDay, timeZone: zoneId })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      const sorted = rows.toSorted((a, b) => b.tokens - a.tokens);
      return {
        sinceDay,
        untilDay: lastDay,
        timeZone: zoneId,
        tokens: sorted.reduce((sum, row) => sum + row.tokens, 0),
        byDefaultTokens: sorted.reduce((sum, row) => sum + (row.byDefault ? row.tokens : 0), 0),
        rows: sorted,
      };
    }),
  ),
  t3_restart_cancel: McpToolAccess.writesEnvironment(() =>
    Effect.gen(function* () {
      yield* access;
      yield* (yield* Orchestrator.OrchestratorV2).cancelRestart;
      return yield* restartStatus;
    }),
  ),
  t3_usage_claim: McpToolAccess.writesEnvironment(
    ({ sessionId, from, directory, threadId, runId, causedBy, fromThread, device, ifUnclaimed }) =>
      Effect.gen(function* () {
        const { threads } = yield* access;
        const path = yield* Path.Path;
        const start = from === undefined ? undefined : DateTime.make(from);
        if (start !== undefined && Option.isNone(start))
          return yield* invalidRequest("from must be an ISO 8601 time.");
        if (start !== undefined && sessionId === undefined)
          return yield* invalidRequest("from goes only with sessionId.");
        // A thread alone names its turn running now, by the rule Usage binds work with.
        const currentRunId =
          threadId !== undefined &&
          runId === undefined &&
          sessionId === undefined &&
          directory === undefined
            ? yield* runningTurn(threadId)
            : undefined;
        const turnRunId = runId ?? currentRunId;
        const targets: UsageClaims.UsageClaimTarget[] = [
          ...(sessionId === undefined
            ? []
            : [
                {
                  kind: "session" as const,
                  sessionId,
                  ...(start === undefined ? {} : { from: start.value }),
                },
              ]),
          ...(directory === undefined ? [] : [{ kind: "directory" as const, directory }]),
          ...(turnRunId === undefined ? [] : [{ kind: "run" as const, runId: turnRunId }]),
        ];
        const target = targets.length === 1 ? targets[0]! : undefined;
        if (target === undefined)
          return yield* invalidRequest("Give exactly one of sessionId, directory or threadId.");
        if ((target.kind === "run") !== (threadId !== undefined))
          return yield* invalidRequest("threadId goes with runId, and only with runId.");
        if (target.kind === "directory" && !path.isAbsolute(target.directory))
          return yield* invalidRequest("directory must be an absolute path.");
        const values = [causedBy, fromThread, device].filter((value) => value !== undefined);
        if (values.length !== 1)
          return yield* invalidRequest("Give exactly one of causedBy, fromThread or device.");
        if (causedBy === null && ifUnclaimed === true)
          return yield* invalidRequest("ifUnclaimed goes only with a claim, not a removal.");
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
            : fromThread !== undefined
              ? yield* boundClaim(threads, fromThread)
              : causedBy === null || causedBy === undefined
                ? null
                : { causedBy: yield* verifyCause(threads, causedBy) };
        const claimed = yield* (yield* UsageClaims.UsageClaims)
          .claim({ target, value, ifUnclaimed: ifUnclaimed === true })
          .pipe(Effect.mapError(unavailable));
        return {
          ...(claimed.target.kind === "session"
            ? {
                sessionId: claimed.target.sessionId,
                ...(claimed.target.from === undefined
                  ? {}
                  : { from: DateTime.formatIso(claimed.target.from) }),
              }
            : claimed.target.kind === "directory"
              ? { directory: claimed.target.directory }
              : { threadId, runId: turnRunId }),
          causedBy:
            claimed.value !== null && "causedBy" in claimed.value ? claimed.value.causedBy : null,
          device: claimed.value !== null && "device" in claimed.value ? claimed.value.device : null,
          ...(claimed.value !== null && "bound" in claimed.value && claimed.value.bound
            ? { reason: claimed.value.bound.reason }
            : {}),
          ...(claimed.kept ? { kept: true as const } : {}),
        };
      }),
  ),
});
