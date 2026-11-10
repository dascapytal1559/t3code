import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { useRightPanelStore } from "../../rightPanelStore";

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
