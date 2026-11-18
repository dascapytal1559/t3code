import {
  AuthOrchestrationOperateScope,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SquareArrowOutUpRightIcon } from "lucide-react";

import { useRemoteOpenState } from "~/remoteOpen";
import { useEnvironmentScope } from "~/state/session";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSurfaceAction } from "./fileSurfaceChrome";

/**
 * Fork: opens a file the panel only previews, such as a video, in the host's own app for it.
 * Offered only where the host is this computer, since it opens on the host.
 */
export function OpenInDefaultAppAction(props: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly availableEditors: ReadonlyArray<EditorId>;
}) {
  const gt = useGT();
  const remote = useRemoteOpenState(props.environmentId);
  const canOperateHost = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "open in default app");
  if (
    remote.mode !== "local-exec" ||
    !canOperateHost ||
    !props.availableEditors.includes("file-manager")
  ) {
    return null;
  }
  return (
    <FileSurfaceAction
      label={gt("Open in default app")}
      onPress={() =>
        void openInEditor({
          environmentId: props.environmentId,
          input: { cwd: props.absolutePath, editor: "file-manager" },
        })
      }
    >
      <SquareArrowOutUpRightIcon className="size-3.5" />
    </FileSurfaceAction>
  );
}
