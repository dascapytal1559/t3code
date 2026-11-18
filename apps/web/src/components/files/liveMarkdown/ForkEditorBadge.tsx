import { T } from "gt-react";
import { GitForkIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** Marks the live editor as the fork's own, so it is never mistaken for upstream's preview. */
export function ForkEditorBadge() {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="info" size="sm" data-fork-editor-badge />}>
        <GitForkIcon />
        <T>Fork editor</T>
      </TooltipTrigger>
      <TooltipPopup>
        <T>The fork's live Markdown editor. Upstream shows a read-only preview.</T>
      </TooltipPopup>
    </Tooltip>
  );
}
