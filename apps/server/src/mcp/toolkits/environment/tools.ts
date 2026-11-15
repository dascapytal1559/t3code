import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  ModelRouting,
  Objectives,
  OrchestrationV2CausedBy,
  OrchestratorMcpCausedBy,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  RestartRequest,
  RestartRequestStatus,
  RunId,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as UsageClaims from "../../../usage/UsageClaims.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    Orchestrator.OrchestratorV2,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const ObjectivesSetTool = Tool.make("t3_objectives_set", {
  ...shared,
  description:
    "Replace the user's high level objectives, shown atop T3's Bridge tab. `markdown`: the whole list, one bullet each (**Name** then a sentence or two); null clears them.",
  parameters: Schema.Struct({
    markdown: Schema.NullOr(Objectives.fields.markdown),
  }),
  success: Schema.Struct({ objectives: Schema.NullOr(Objectives) }),
}).annotate(Tool.Destructive, true);
const RoutingSetTool = Tool.make("t3_routing_set", {
  ...shared,
  description:
    "Replace the model routing table shown in T3's Bridge tab. `markdown`: the whole table, one rule per row; null clears it.",
  parameters: Schema.Struct({
    markdown: Schema.NullOr(ModelRouting.fields.markdown),
  }),
  success: Schema.Struct({ modelRouting: Schema.NullOr(ModelRouting) }),
}).annotate(Tool.Destructive, true);
const RestartRequestTool = Tool.make("t3_restart_request", {
  ...shared,
  description:
    "Ask T3 to wait for a restart (e.g. installing a build). Running turns finish; new messages queue held and send after it. T3 never restarts itself: restart it once `t3_restart_status` reports `drained`. `causedBy`: the prompt whose work it installs.",
  parameters: Schema.Struct({
    reason: RestartRequest.fields.reason,
    causedBy: Schema.optional(OrchestratorMcpCausedBy),
  }),
  success: RestartRequestStatus,
}).annotate(Tool.Destructive, true);
const UsageClaimTool = Tool.make("t3_usage_claim", {
  ...shared,
  dependencies: [...shared.dependencies, UsageClaims.UsageClaims, Path.Path],
  description:
    "Count work Usage can't trace on its own. Target one of: `sessionId` (native id) or an absolute `directory`, for sessions run outside T3 (a pipeline, a CLI run); `threadId` + `runId`, for a turn whose prompt has no cause (a wake). Give `causedBy` (the prompt behind it) or `device` (`computer` for upkeep, `phone` for a voice journal); work a claimed turn causes inherits it. Claiming again replaces it; `causedBy: null` removes it. Your own worktree needs no claim.",
  parameters: Schema.Struct({
    sessionId: Schema.optional(TrimmedNonEmptyString),
    directory: Schema.optional(TrimmedNonEmptyString),
    threadId: Schema.optional(ThreadId),
    runId: Schema.optional(RunId),
    causedBy: Schema.optional(Schema.NullOr(OrchestratorMcpCausedBy)),
    device: Schema.optional(Schema.Literals(["phone", "computer"])),
  }),
  success: Schema.Struct({
    sessionId: Schema.optional(Schema.String),
    directory: Schema.optional(Schema.String),
    threadId: Schema.optional(ThreadId),
    runId: Schema.optional(RunId),
    causedBy: Schema.NullOr(OrchestrationV2CausedBy),
    device: Schema.NullOr(Schema.Literals(["phone", "computer"])),
  }),
}).annotate(Tool.Destructive, false);
const RestartStatusTool = Tool.make("t3_restart_status", {
  ...shared,
  description: "Read the pending restart. `activeTurns` counts every running turn, yours too.",
  success: RestartRequestStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const RestartCancelTool = Tool.make("t3_restart_cancel", {
  ...shared,
  description: "Cancel the pending restart; held messages send now.",
  success: RestartRequestStatus,
}).annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  ObjectivesSetTool,
  RoutingSetTool,
  RestartRequestTool,
  RestartStatusTool,
  RestartCancelTool,
  UsageClaimTool,
);
