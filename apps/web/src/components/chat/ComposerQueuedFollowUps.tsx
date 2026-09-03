import { PaperclipIcon, XIcon } from "lucide-react";
import { memo } from "react";

import {
  queuedFollowUpHasAttachments,
  queuedFollowUpPreview,
  type QueuedFollowUp,
} from "../../queuedFollowUpStore";
import { ComposerBanner } from "./ComposerBanner";

export const ComposerQueuedFollowUps = memo(function ComposerQueuedFollowUps({
  items,
  onRemove,
}: {
  items: ReadonlyArray<QueuedFollowUp>;
  onRemove: (followUpId: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-chat-composer-queued-follow-ups="true">
        <div className="flex flex-col gap-1 px-2 pb-1 pt-1.5">
          <div className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Queued · {items.length}
          </div>
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => (
              <li key={item.id}>
                <div className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/4">
                  <span className="w-4 shrink-0 text-center text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  {queuedFollowUpHasAttachments(item) ? (
                    <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-foreground/90">
                    {queuedFollowUpPreview(item)}
                  </span>
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
                    aria-label="Remove queued message"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onRemove(item.id)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
