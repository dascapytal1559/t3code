import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { ArchiveIcon, ArrowUpIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const failureToast = (title: string, error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });

/**
 * The composer of a crew thread FirstMate kept open for the user: the words go to FirstMate, not
 * the worker, and Archive closes the thread.
 */
export function KeptThreadReply(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const reply = useAtomCommand(orchestrationEnvironment.replyToKeptThread);
  const permitted = useAtomValue(
    orchestrationEnvironment.replyToKeptThread.permissionAtom(environmentId),
  );
  const { archiveThread } = useThreadActions();
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || !permitted) return;
    setSending(true);
    const result = await reply({
      environmentId,
      input: {
        threadId,
        commandId: CommandId.make(`web:kept-reply:${randomUUID()}`),
        text: trimmed,
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failureToast("Could not send to FirstMate", squashAtomCommandFailure(result));
      }
      return;
    }
    setText("");
    toastManager.add({
      type: "success",
      title: "Sent to FirstMate",
      description: result.value.queued
        ? "It waits until FirstMate's current turn ends."
        : "FirstMate has started on it.",
    });
  };

  const archive = async () => {
    if (confirmThreadArchive) {
      const confirmed = await readLocalApi()
        ?.dialogs.confirm("Archive this thread?")
        .catch(() => false);
      if (confirmed !== true) return;
    }
    const result = await archiveThread(props.threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Failed to archive thread", squashAtomCommandFailure(result));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="rounded-2xl border border-border bg-card shadow-xs/5 focus-within:border-ring">
      <textarea
        aria-label="Reply to FirstMate about this thread"
        className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="Reply to FirstMate about this thread…"
        value={text}
        disabled={!permitted}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center justify-end gap-2 px-3 pb-3">
        <Button variant="ghost-muted" size="sm" onClick={() => void archive()}>
          <ArchiveIcon aria-hidden />
          Archive
        </Button>
        <Button
          size="sm"
          disabled={!permitted || sending || text.trim().length === 0}
          onClick={() => void send()}
        >
          Send to FirstMate
          <ArrowUpIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
