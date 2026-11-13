import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type DecisionActInput, type ScopedThreadRef } from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { randomUUID } from "../../lib/utils";
import { decisionListsAtom } from "../../state/decisions";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { resolveCaptainCards, type CaptainCard } from "./coordinatorGroup.logic";

/** FirstMate's item cards by thread key; a dated snooze returns on the minute it ends. */
export function useCaptainCards(): ReadonlyMap<string, CaptainCard> {
  const lists = useAtomValue(decisionListsAtom);
  const nowMinute = useNowMinute();
  return resolveCaptainCards(lists, Date.parse(`${nowMinute}:00.000Z`));
}

export function useCaptainCard(threadRef: ScopedThreadRef | null): CaptainCard | null {
  const cards = useCaptainCards();
  return threadRef === null ? null : (cards.get(scopedThreadKey(threadRef)) ?? null);
}

const FAILURE_TITLES: Record<DecisionActInput["action"]["type"], string> = {
  snooze: "Could not snooze",
  unsnooze: "Could not bring it back",
  archive: "Could not archive",
};

/**
 * Snooze, bring back or archive a FirstMate item. Each is logged for FirstMate to apply to its
 * own records; the card moves at once and FirstMate's next list confirms it.
 */
export function useCaptainItemAct() {
  const act = useAtomCommand(orchestrationEnvironment.actOnDecision);
  return async (card: CaptainCard, action: DecisionActInput["action"]): Promise<boolean> => {
    const result = await act({
      environmentId: card.environmentId,
      input: {
        decisionId: card.item.id,
        commandId: CommandId.make(`web:decision-act:${randomUUID()}`),
        revision: card.item.revision,
        action,
      },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: FAILURE_TITLES[action.type],
        description: error instanceof Error ? error.message : undefined,
      });
    }
    return false;
  };
}
