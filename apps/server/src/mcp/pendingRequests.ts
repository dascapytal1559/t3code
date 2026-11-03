import {
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpPendingApproval,
  type OrchestratorMcpPendingRequests,
  ProviderRequestKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const isApprovalKind = Schema.is(ProviderRequestKind);

export const pendingApproval = (
  request: OrchestrationV2RuntimeRequest,
  kind: ProviderRequestKind,
  turnItems: OrchestrationV2ThreadProjection["turnItems"],
): OrchestratorMcpPendingApproval => {
  const item = turnItems.findLast(
    (item) => item.type === "approval_request" && item.requestId === request.id,
  );
  const approval = item?.type === "approval_request" ? item : undefined;
  return {
    requestId: request.id,
    type: "approval",
    kind,
    ...(approval?.prompt === undefined ? {} : { detail: approval.prompt }),
    ...(approval?.reason === undefined ? {} : { reason: approval.reason }),
    override: approval?.fullAccessOverride ?? null,
    supportsFeedback:
      request.responseCapability.type === "live" &&
      request.responseCapability.supportsFeedback === true,
  };
};

export const listPendingRequests = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): OrchestratorMcpPendingRequests => {
  const pending = projection.runtimeRequests.filter((request) => request.status === "pending");
  return {
    requestIds: pending
      .filter((request) => request.kind === "user_input")
      .map((request) => request.id),
    approvals: pending.flatMap((request) => {
      const kind = request.kind;
      return isApprovalKind(kind) ? [pendingApproval(request, kind, projection.turnItems)] : [];
    }),
  };
};
