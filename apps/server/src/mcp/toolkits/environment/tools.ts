import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  DecisionsSetInput,
  DecisionsSetResult,
  ExecutionEnvironmentDescriptor,
  ModelRouting,
  Objectives,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PinnedReport,
  PinnedReportId,
  RestartRequest,
  RestartRequestStatus,
  RulesSetInput,
  RulesSetResult,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Decisions from "../../../decisions/Decisions.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as Rules from "../../../rules/Rules.ts";
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
    Decisions.Decisions,
    Rules.Rules,
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
const PinnedReportsResult = Schema.Struct({
  reports: Schema.Array(
    Schema.Struct({ id: PinnedReportId, title: Schema.String, pinnedAt: Schema.String }),
  ),
});
const ReportsPinTool = Tool.make("t3_reports_pin", {
  ...shared,
  description:
    "Pin a finished report to the Reports section of T3's Bridge tab. `id` is yours; pinning it again replaces it. `location`: absolute path to the report or an http(s) link. Returns every pinned report, newest first; the user may unpin.",
  parameters: Schema.Struct({
    id: PinnedReportId,
    title: PinnedReport.fields.title,
    summary: PinnedReport.fields.summary,
    location: PinnedReport.fields.location,
  }),
  success: PinnedReportsResult,
}).annotate(Tool.Destructive, false);
const ReportsUnpinTool = Tool.make("t3_reports_unpin", {
  ...shared,
  description:
    "Unpin a report from T3's Bridge tab; an id not pinned changes nothing. Returns every pinned report, newest first.",
  parameters: Schema.Struct({ id: PinnedReportId }),
  success: PinnedReportsResult,
}).annotate(Tool.Destructive, true);
const DecisionsSetTool = Tool.make("t3_decisions_set", {
  ...shared,
  description:
    "Replace the decisions the user owes, listed in T3's Bridge tab. `decisions`: the whole list; one left out is gone, an identical list changes nothing. Replies go to thread `replyTo`.",
  parameters: DecisionsSetInput,
  success: DecisionsSetResult,
}).annotate(Tool.Destructive, true);
const RulesSetTool = Tool.make("t3_rules_set", {
  ...shared,
  description:
    "Replace the user's rules listed in T3's Bridge tab. `rules`: the whole list in order (empty clears it); a pending rule needs `recommendation`. The user's agreement arrives in your chat as `rule-answer: <id> <choice>`.",
  parameters: RulesSetInput,
  success: RulesSetResult,
}).annotate(Tool.Destructive, true);
const RestartRequestTool = Tool.make("t3_restart_request", {
  ...shared,
  description:
    "Ask T3 to wait for a restart (e.g. installing a build). Running turns finish; new messages queue held and send after it. T3 never restarts itself: restart it once `t3_restart_status` reports `drained`.",
  parameters: Schema.Struct({ reason: RestartRequest.fields.reason }),
  success: RestartRequestStatus,
}).annotate(Tool.Destructive, true);
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
  ReportsPinTool,
  ReportsUnpinTool,
  DecisionsSetTool,
  RulesSetTool,
  RestartRequestTool,
  RestartStatusTool,
  RestartCancelTool,
);
