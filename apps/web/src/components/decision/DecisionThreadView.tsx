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
import {
  CommandId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadDecision,
  type ThreadDecisionEntry,
  type ThreadId,
  threadDecisionSince,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowUpIcon, ClockIcon, CornerDownLeftIcon, HandIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { decisionAttachmentsMarkdown, decisionReplyCommandId } from "./decisionView.logic";

// Words an Undo took back, so the reply box shows them again even after the view remounted.
const restoredDrafts = new Map<string, string>();

const LATER_DRAFT = "Later: ask me again next week.";

const dayLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const formatDay = (iso: string) => dayLabel.format(Date.parse(iso));

/**
 * A FirstMate decision: the question and options, then FirstMate's messages as sent. Replying
 * sends one message into FirstMate's chat and settles this thread; the thread itself has no agent.
 */
export function DecisionThreadView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useQuietThreadShell(threadRef);
  const detail = useEnvironmentThread(props.environmentId, props.threadId);
  const thread = Option.getOrNull(Option.map(detail.data, (projection) => projection.thread));
  const project = useProject(
    shell === null ? null : scopeProjectRef(props.environmentId, shell.projectId),
  );
  const decision = thread?.decision ?? null;
  const coordinatorId = thread?.decisionOf ?? shell?.decisionOf ?? null;
  const title = decision?.title ?? shell?.title ?? "Decision";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <ThreadVisitWatermark threadRef={threadRef} />
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <HandIcon aria-hidden className="size-4 shrink-0 text-warning" />
          <span className="shrink-0 text-muted-foreground">Needs you</span>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
        </div>
      </WorkspacePageHeader>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-6">
          {thread === null ? null : decision === null ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              FirstMate cleared this decision. Nothing is waiting on you here.
            </p>
          ) : (
            <>
              <DecisionQuestion decision={decision} />
              {decision.entries.map((entry, index) => (
                <DecisionEntryView
                  // oxlint-disable-next-line react/no-array-index-key -- entries have no id and only ever grow at the end
                  key={`${index}:${entry.at}`}
                  entry={entry}
                  environmentId={props.environmentId}
                  threadRef={threadRef}
                  cwd={project?.workspaceRoot}
                  project={project}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {decision === null || coordinatorId === null ? null : (
        <DecisionReplyBox
          // A new thread starts with its own empty box.
          key={scopedThreadKey(threadRef)}
          threadRef={threadRef}
          coordinatorId={coordinatorId}
          decision={decision}
        />
      )}
    </div>
  );
}

function DecisionQuestion(props: { readonly decision: ThreadDecision }) {
  const since = threadDecisionSince(props.decision);
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-2xs font-semibold tracking-wide text-warning uppercase">
        Needs you{since === null ? "" : ` · waiting since ${formatDay(since)}`}
      </p>
      <p className="mt-1 text-sm font-medium whitespace-pre-wrap text-foreground">
        {props.decision.question}
      </p>
      {props.decision.options.length === 0 ? null : (
        <ul className="mt-2 flex list-disc flex-col gap-2 ps-8 text-sm">
          {props.decision.options.map((option) => (
            <li key={option.label}>
              <span className="text-foreground">{option.label}</span>
              {option.detail === undefined ? null : (
                <span className="block text-xs text-muted-foreground">{option.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DecisionEntryView(props: {
  readonly entry: ThreadDecisionEntry;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly project: Parameters<typeof ProjectFavicon>[0]["project"] | null;
}) {
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { entry } = props;
  const source = entry.message?.thread;
  const attachments = decisionAttachmentsMarkdown(entry.attachments ?? []);
  return (
    <article className="flex flex-col gap-2">
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
        {source === undefined ? null : (
          <button
            type="button"
            className="ms-auto inline-flex cursor-pointer items-center gap-1 rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(props.environmentId, source)),
              })
            }
          >
            <CornerDownLeftIcon aria-hidden className="size-3.5" />
            In FirstMate's chat
          </button>
        )}
      </header>
      <ChatMarkdown
        text={entry.text}
        cwd={props.cwd}
        threadRef={props.threadRef}
        environmentId={props.environmentId}
      />
      {attachments === null ? null : (
        <ChatMarkdown
          text={attachments}
          cwd={props.cwd}
          imageBaseDir={props.cwd}
          threadRef={props.threadRef}
          environmentId={props.environmentId}
        />
      )}
    </article>
  );
}

function DecisionReplyBox(props: {
  readonly threadRef: ScopedThreadRef;
  readonly coordinatorId: ThreadId;
  readonly decision: ThreadDecision;
}) {
  const { environmentId } = props.threadRef;
  const navigate = useNavigate();
  const draftKey = scopedThreadKey(props.threadRef);
  const [text, setText] = useState(() => {
    const restored = restoredDrafts.get(draftKey) ?? "";
    restoredDrafts.delete(draftKey);
    return restored;
  });
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
  const coordinatorRef = scopeThreadRef(environmentId, props.coordinatorId);
  const openCoordinator = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(coordinatorRef),
    });

  const takeBack = async (commandId: CommandId, sentText: string) => {
    const result = await undo({
      environmentId,
      input: { threadId: props.threadRef.threadId, commandId },
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
        description: "It started on your reply, so it stays sent.",
      });
      return;
    }
    // Shown at once when this box is still open, or when the thread opens next.
    restoredDrafts.set(draftKey, sentText);
    setText(sentText);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(props.threadRef),
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
        threadId: props.threadRef.threadId,
        commandId,
        text: trimmed,
        revision: props.decision.revision,
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
      title: `Sent to FirstMate · ${props.decision.title} settled`,
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
    openCoordinator();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(text);
  };

  return (
    <div className="shrink-0 px-4 pb-3 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-2xl border border-border bg-card shadow-xs/5 focus-within:border-ring">
          {props.decision.options.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {props.decision.options.map((option) => (
                <Button
                  key={option.label}
                  variant="outline"
                  size="sm-pill"
                  aria-pressed={text === option.label}
                  onClick={() => updateText(option.label)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
          <textarea
            aria-label="Reply to FirstMate about this decision"
            className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
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
          Sends to FirstMate's chat with this decision quoted, then this thread settles.
        </p>
      </div>
    </div>
  );
}
