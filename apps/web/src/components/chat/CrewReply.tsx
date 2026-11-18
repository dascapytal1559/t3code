import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { ArrowUpIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { newMessageId } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { coordinatorMessageInput, formatCrewReply } from "./CrewReply.logic";

/**
 * Upstream's composer wrapper, left out on a FirstMate worker's thread. A component, not a
 * conditional around the composer, so upstream's markup inside keeps its indentation.
 */
export function CrewComposerGate(props: {
  readonly hidden: boolean;
  readonly children: ReactNode;
}) {
  return props.hidden ? null : <div className="relative">{props.children}</div>;
}

/**
 * The box on a FirstMate worker's thread. Its words go to the worker's coordinator as one user
 * message naming the worker, never to the worker; the ring is the worker's own context window.
 */
export function CrewReply(props: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">;
  readonly coordinator: Pick<EnvironmentThreadShell, "id" | "runtimeMode" | "interactionMode">;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly disabled: boolean;
}) {
  const { thread, coordinator } = props;
  const gt = useGT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const send = async () => {
    const sent = text;
    if (sent.trim().length === 0 || sending || props.disabled) return;
    setSending(true);
    const result = await startTurn({
      environmentId: thread.environmentId,
      input: coordinatorMessageInput({
        coordinator,
        messageId: newMessageId(),
        text: formatCrewReply({ thread, text: sent }),
        crewNote: { threadId: thread.id, kind: "reply" },
      }),
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not send to FirstMate"),
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    setText((current) => (current === sent ? "" : current));
    toastManager.add({ type: "success", title: gt("Sent to FirstMate") });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="rounded-2xl border border-border bg-card shadow-xs/5 focus-within:border-ring">
      <textarea
        aria-label={gt("Reply to FirstMate about this thread")}
        className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={gt("Reply to FirstMate about this thread…")}
        value={text}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center justify-end gap-2 px-3 pb-3">
        {props.contextWindow === null ? null : <ContextWindowMeter usage={props.contextWindow} />}
        <Button
          size="sm"
          disabled={props.disabled || sending || text.trim().length === 0}
          onClick={() => void send()}
        >
          <T>Send to FirstMate</T>
          <ArrowUpIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
