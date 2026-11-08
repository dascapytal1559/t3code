import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RestartRequest } from "@t3tools/contracts";
import { RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryRestartRequestAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

/** App-wide while the primary server waits to restart; see `t3_restart_request`. */
export function RestartPendingNotice() {
  const request = useAtomValue(primaryRestartRequestAtom);
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  if (request === null || environmentId === null) return null;
  return <RestartPendingAlert environmentId={environmentId} request={request} />;
}

function RestartPendingAlert(props: {
  readonly environmentId: EnvironmentId;
  readonly request: RestartRequest;
}) {
  const cancel = useAtomCommand(serverEnvironment.cancelRestartRequest);
  const permitted = useAtomValue(
    serverEnvironment.cancelRestartRequest.permissionAtom(props.environmentId),
  );
  const [cancelling, setCancelling] = useState(false);

  const cancelRestart = async () => {
    setCancelling(true);
    const result = await cancel({ environmentId: props.environmentId, input: {} });
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

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-40 flex justify-center px-4 [-webkit-app-region:no-drag]">
      <div className="pointer-events-auto w-fit max-w-full">
        <Alert variant="info" role="status" surface="glass" controlAlignment="first-line">
          <RotateCwIcon />
          <AlertTitle>T3 will restart when running turns finish</AlertTitle>
          <AlertDescription>
            {props.request.reason}. New messages queue and send after the restart.
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={!permitted || cancelling}
              onClick={() => void cancelRestart()}
            >
              Cancel restart
            </Button>
          </AlertAction>
        </Alert>
      </div>
    </div>
  );
}
