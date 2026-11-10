import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { useRestartRequest } from "../../hooks/useRestartPending";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** The primary server waits to restart (see `t3_restart_request`), so this composer's sends queue. */
export function useRestartPendingBanner(
  environmentId: EnvironmentId,
): ComposerBannerStackItem | null {
  const request = useRestartRequest(environmentId);
  const cancel = useAtomCommand(serverEnvironment.cancelRestartRequest);
  const permitted = useAtomValue(
    serverEnvironment.cancelRestartRequest.permissionAtom(environmentId),
  );
  const [cancelling, setCancelling] = useState(false);

  if (request === null) return null;

  const cancelRestart = async () => {
    setCancelling(true);
    const result = await cancel({ environmentId, input: {} });
    setCancelling(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not cancel the restart",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return {
    id: "restart-pending",
    variant: "info",
    group: "environment",
    icon: <RotateCwIcon />,
    title: "T3 will restart when running turns finish",
    description: `${request.reason}. New messages queue and send after the restart.`,
    actions: (
      <Button
        size="xs"
        variant="outline"
        disabled={!permitted || cancelling}
        onClick={() => void cancelRestart()}
      >
        Cancel restart
      </Button>
    ),
  };
}
