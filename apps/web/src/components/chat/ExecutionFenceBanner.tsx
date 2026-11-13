import { PauseCircleIcon } from "lucide-react";
import { useState } from "react";

import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** FirstMate retired this thread from running; Resume lifts the fence so the next send runs. */
export function executionFenceBannerItem(
  onResume: () => Promise<void>,
  canResume: boolean,
): ComposerBannerStackItem {
  return {
    id: "execution-fence",
    variant: "info",
    icon: <PauseCircleIcon />,
    title: "Paused by FirstMate",
    description: "Its workspace went back to FirstMate. Resume to let the agent run here again.",
    actions: <ResumeAction onResume={onResume} canResume={canResume} />,
  };
}

function ResumeAction({
  onResume,
  canResume,
}: {
  readonly onResume: () => Promise<void>;
  readonly canResume: boolean;
}) {
  const [pending, setPending] = useState(false);
  async function resume() {
    setPending(true);
    try {
      await onResume();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not resume thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  return (
    <InlineButton
      touchTarget="padded"
      disabled={!canResume || pending}
      onClick={() => void resume()}
    >
      {pending ? "Resuming..." : "Resume"}
    </InlineButton>
  );
}
