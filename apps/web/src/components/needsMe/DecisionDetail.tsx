import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CommandId, DecisionEntry, ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, ClockIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import type { BridgeDecision } from "../../state/decisions";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  bridgeDecisionKey,
  decisionAttachmentsMarkdown,
  decisionMarkdownScope,
  decisionReplyCommandId,
  formatDay,
} from "./needsMe.logic";
import { revealDecision, useNeedsMeOpenRow } from "./needsMeReveal";

// Words an Undo took back, so the reply box shows them again even after the row remounted.
const restoredDrafts = new Map<string, string>();

const LATER_DRAFT = "Later: ask me again next week.";

/**
 * One FirstMate decision, open in the Bridge tab: FirstMate's messages as sent, then the reply
 * box with the options as buttons. Replying sends one message into FirstMate's chat and takes the
 * decision off the list.
 */
export function DecisionDetail(props: {
  readonly item: BridgeDecision;
  /** The thread whose chat the panel sits beside. */
  readonly hostRef: ScopedThreadRef;
}) {
  const { environmentId, replyTo, decision } = props.item;
  const coordinatorRef = replyTo === null ? null : scopeThreadRef(environmentId, replyTo);
  const coordinator = useQuietThreadShell(coordinatorRef);
  const project = useProject(
    coordinator === null ? null : scopeProjectRef(environmentId, coordinator.projectId),
  );
  const hostShell = useQuietThreadShell(props.hostRef);
  const hostProject = useProject(
    hostShell === null ? null : scopeProjectRef(props.hostRef.environmentId, hostShell.projectId),
  );
  const markdownScope = decisionMarkdownScope({
    coordinatorRef: coordinatorRef ?? props.hostRef,
    hostRef: props.hostRef,
    decisionRoot: project?.workspaceRoot,
    hostRoot:
      hostProject === null
        ? undefined
        : projectScriptCwd({
            project: { cwd: hostProject.workspaceRoot },
            worktreePath: hostShell?.worktreePath ?? null,
          }),
  });

  return (
    <div className="flex flex-col gap-4 pt-2 pb-3">
      {decision.entries.map((entry, index) => (
        <DecisionEntryView
          // oxlint-disable-next-line react/no-array-index-key -- entries have no id and only ever grow at the end
          key={`${index}:${entry.at}`}
          entry={entry}
          environmentId={environmentId}
          markdownScope={markdownScope}
          project={project}
        />
      ))}
      {coordinatorRef === null ? null : (
        <DecisionReplyBox
          item={props.item}
          hostRef={props.hostRef}
          coordinatorRef={coordinatorRef}
        />
      )}
    </div>
  );
}

function DecisionEntryView(props: {
  readonly entry: DecisionEntry;
  readonly environmentId: BridgeDecision["environmentId"];
  readonly markdownScope: ReturnType<typeof decisionMarkdownScope>;
  readonly project: Parameters<typeof ProjectFavicon>[0]["project"] | null;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { entry, environmentId } = props;
  const attachments = decisionAttachmentsMarkdown(entry.attachments ?? []);
  return (
    <article className="flex min-w-0 flex-col gap-2">
      {entry.kind === "update" ? (
        <>
          <div className="flex items-center gap-3 text-xs font-medium text-warning">
            <span aria-hidden className="h-px flex-1 bg-border" />
            <span className="inline-flex items-center gap-1">
              <ClockIcon aria-hidden className="size-3.5" />
              Updated {formatDay(entry.at)}
            </span>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
          {entry.changed === undefined ? null : (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-foreground">
              <span className="font-semibold">What changed:</span> {entry.changed}
            </p>
          )}
        </>
      ) : null}
      <header className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}
        <span>FirstMate · {formatDayAwareTimestamp(entry.at, timestampFormat)}</span>
      </header>
      <ChatMarkdown text={entry.text} {...props.markdownScope} environmentId={environmentId} />
      {attachments === null ? null : (
        <ChatMarkdown text={attachments} {...props.markdownScope} environmentId={environmentId} />
      )}
    </article>
  );
}

function DecisionReplyBox(props: {
  readonly item: BridgeDecision;
  readonly hostRef: ScopedThreadRef;
  /** FirstMate's chat. */
  readonly coordinatorRef: ScopedThreadRef;
}) {
  const { environmentId, decision } = props.item;
  const { coordinatorRef } = props;
  const navigate = useNavigate();
  const draftKey = bridgeDecisionKey(props.item);
  const [text, setText] = useState(() => restoredDrafts.get(draftKey) ?? "");
  // Once the words change, an earlier Undo's copy is stale.
  const updateText = (next: string) => {
    restoredDrafts.delete(draftKey);
    setText(next);
  };
  const [sending, setSending] = useState(false);
  const reply = useAtomCommand(orchestrationEnvironment.replyToDecision);
  const undo = useAtomCommand(orchestrationEnvironment.undoDecisionReply);
  const permitted = useAtomValue(
    orchestrationEnvironment.replyToDecision.permissionAtom(environmentId),
  );
  // The Bridge tab comes along, so the list stays beside FirstMate's chat.
  const showCoordinator = () => {
    if (scopedThreadKey(props.hostRef) === scopedThreadKey(coordinatorRef)) return;
    useRightPanelStore.getState().open(coordinatorRef, "needs-me");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(coordinatorRef),
    });
  };

  const takeBack = async (commandId: CommandId, sentText: string) => {
    const result = await undo({
      environmentId,
      input: { decisionId: decision.id, commandId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not take the reply back",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    if (!result.value.withdrawn) {
      toastManager.add({
        type: "info",
        title: "FirstMate already has it",
        description: "FirstMate has it now, so it stays sent.",
      });
      return;
    }
    // Shown at once when this box is still open, or when the row opens next.
    restoredDrafts.set(draftKey, sentText);
    setText(sentText);
    revealDecision(draftKey, coordinatorRef);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(coordinatorRef),
    });
  };

  const send = async (words: string) => {
    const trimmed = words.trim();
    if (trimmed.length === 0 || sending || !permitted) return;
    setSending(true);
    const commandId = decisionReplyCommandId();
    const result = await reply({
      environmentId,
      input: {
        decisionId: decision.id,
        commandId,
        text: trimmed,
        revision: decision.revision,
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not send to FirstMate",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    updateText("");
    const toastId = toastManager.add({
      type: "success",
      title: `Sent to FirstMate · ${decision.title}`,
      description: result.value.queued
        ? "It waits until FirstMate's current turn ends."
        : "FirstMate has started on it.",
      // Only a reply still in the queue can be taken back.
      ...(result.value.queued
        ? {
            actionProps: {
              children: "Undo",
              onClick: () => {
                toastManager.close(toastId);
                void takeBack(commandId, trimmed);
              },
            },
          }
        : {}),
    });
    useNeedsMeOpenRow.getState().setOpenKey(null);
    showCoordinator();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(text);
  };

  return (
    <div>
      <div className="rounded-2xl border border-border bg-card shadow-xs/5 focus-within:border-ring">
        {decision.options.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {decision.options.map((option) => (
              <Button
                key={option.label}
                variant="outline"
                size="sm-pill"
                className="max-w-full"
                title={option.label}
                aria-pressed={text === option.label}
                onClick={() => updateText(option.label)}
              >
                <span className="truncate">{option.label}</span>
              </Button>
            ))}
          </div>
        )}
        <textarea
          aria-label="Reply to FirstMate about this decision"
          className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Reply to FirstMate about this decision…"
          value={text}
          disabled={!permitted}
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-end gap-2 px-3 pb-3">
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={!permitted}
            onClick={() => updateText(LATER_DRAFT)}
          >
            <ClockIcon aria-hidden />
            Later
          </Button>
          <Button
            size="sm"
            disabled={!permitted || sending || text.trim().length === 0}
            onClick={() => void send(text)}
          >
            Send to FirstMate
            <ArrowUpIcon aria-hidden />
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-center text-xs text-muted-foreground">
        Sends to FirstMate's chat with this decision quoted, then it leaves this list.
      </p>
    </div>
  );
}
