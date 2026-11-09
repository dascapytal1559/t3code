import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { create } from "zustand";

import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";

/** The decision whose row is open in the Bridge tab, by `bridgeDecisionKey`. */
export const useNeedsMeOpenRow = create<{
  readonly openKey: string | null;
  readonly setOpenKey: (openKey: string | null) => void;
}>()((set) => ({ openKey: null, setOpenKey: (openKey) => set({ openKey }) }));

/** Opens the decision's row in the Bridge tab beside FirstMate's chat. */
export function revealDecision(decisionKey: string, coordinatorRef: ScopedThreadRef) {
  useNeedsMeOpenRow.getState().setOpenKey(decisionKey);
  useRightPanelStore.getState().open(coordinatorRef, "needs-me");
}

/** A decision thread from before the decisions list has no chat: its address shows FirstMate's. */
export function DecisionRedirect(props: {
  readonly decisionRef: ScopedThreadRef;
  readonly coordinatorId: ThreadId;
}) {
  const navigate = useNavigate();
  const { environmentId } = props.decisionRef;
  const { coordinatorId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a route redirect: it navigates when the decision thread's address is visited
  useEffect(() => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, coordinatorId)),
      replace: true,
    });
  }, [environmentId, coordinatorId, navigate]);
  return null;
}
