import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  coordinatorMessageInput,
  formatCrewThreadAction,
  type CrewThreadAction,
} from "../components/chat/CrewReply.logic";
import { isCrewOf } from "../components/sidebar/coordinatorGroup.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newMessageId } from "../lib/utils";
import { readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

/**
 * Fork: tells a crew thread's coordinator that the captain settled or snoozed it, or undid either,
 * in one message sent the way the crew reply box sends. Only the client's own actions call this,
 * so FirstMate's MCP changes and the server's automatic ones never echo back to it.
 */
export function useTellCoordinator() {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return (target: ScopedThreadRef, action: CrewThreadAction) => {
    const thread = readThreadShell(target);
    if (thread?.crewOf === undefined) return;
    const coordinator = readThreadShell(scopeThreadRef(target.environmentId, thread.crewOf));
    if (coordinator === null || !isCrewOf(thread, coordinator)) return;
    void startTurn({
      environmentId: target.environmentId,
      input: coordinatorMessageInput({
        coordinator,
        messageId: newMessageId(),
        text: formatCrewThreadAction({ thread, action }),
      }),
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not tell FirstMate",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };
}
