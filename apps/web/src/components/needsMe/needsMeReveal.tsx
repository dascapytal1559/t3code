import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { create } from "zustand";

import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { isNeedsMeListed } from "./needsMe.logic";

/** The decision whose row is open in the Needs me tab, by scoped thread key. */
export const useNeedsMeOpenRow = create<{
  readonly openKey: string | null;
  readonly setOpenKey: (openKey: string | null) => void;
}>()((set) => ({ openKey: null, setOpenKey: (openKey) => set({ openKey }) }));

/** Opens the decision's row in the Needs me tab of its coordinator's chat. */
export function revealDecision(decisionRef: ScopedThreadRef, coordinatorRef: ScopedThreadRef) {
  useNeedsMeOpenRow.getState().setOpenKey(scopedThreadKey(decisionRef));
  useRightPanelStore.getState().open(coordinatorRef, "needs-me");
}

/**
 * A decision thread's own address shows FirstMate's chat, with the decision open beside it
 * while the Needs me tab lists it.
 */
export function DecisionRedirect(props: {
  readonly decisionRef: ScopedThreadRef;
  readonly coordinatorId: ThreadId;
  readonly shell: EnvironmentThreadShell;
}) {
  const navigate = useNavigate();
  const { environmentId, threadId } = props.decisionRef;
  const { coordinatorId, shell } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a route redirect: it opens the panel and navigates when the decision's address is visited
  useEffect(() => {
    const coordinatorRef = scopeThreadRef(environmentId, coordinatorId);
    if (isNeedsMeListed(shell, new Date()))
      revealDecision(scopeThreadRef(environmentId, threadId), coordinatorRef);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(coordinatorRef),
      replace: true,
    });
  }, [environmentId, threadId, coordinatorId, shell, navigate]);
  return null;
}
