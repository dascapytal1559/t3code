import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  ArrowUpIcon,
  ChevronDownIcon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { decisionReplyCommandId } from "../needsMe/needsMe.logic";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import type { CaptainCard } from "../sidebar/coordinatorGroup.logic";
import { useCaptainItemAct } from "../sidebar/useCaptainCards";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

const failureToast = (title: string, error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });

const REFUSED_ACTION: Record<NonNullable<CaptainCard["item"]["refused"]>["type"], string> = {
  snooze: "snooze this",
  unsnooze: "bring this back",
  archive: "archive this",
  "thread-archived": "close this for the archived thread",
  "thread-unarchived": "reopen this",
};

/**
 * The composer of a crew thread that carries FirstMate's item, or that FirstMate kept open for the
 * user: the words go to FirstMate, not the worker. With an item, Snooze puts it off and Archive
 * closes it; FirstMate applies both to its own records.
 */
export function KeptThreadReply(props: {
  readonly threadRef: ScopedThreadRef;
  readonly captainCard: CaptainCard | null;
}) {
  const { environmentId, threadId } = props.threadRef;
  const card = props.captainCard;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const replyToThread = useAtomCommand(orchestrationEnvironment.replyToKeptThread);
  const replyToItem = useAtomCommand(orchestrationEnvironment.replyToDecision);
  const permitted = useAtomValue(
    orchestrationEnvironment.replyToKeptThread.permissionAtom(environmentId),
  );
  const act = useCaptainItemAct();
  const { archiveThread } = useThreadActions();
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || !permitted) return;
    setSending(true);
    const result =
      card === null
        ? await replyToThread({
            environmentId,
            input: {
              threadId,
              commandId: CommandId.make(`web:kept-reply:${randomUUID()}`),
              text: trimmed,
            },
          })
        : await replyToItem({
            environmentId,
            input: {
              decisionId: card.item.id,
              commandId: decisionReplyCommandId(),
              text: trimmed,
              revision: card.item.revision,
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
    // A worker still running is FirstMate's to wind down safely, so only the item closes here.
    if (card !== null && card.item.thread?.finished !== true) {
      if (await act(card, { type: "archive" })) {
        toastManager.add({
          type: "success",
          title: "Archived",
          description: "FirstMate closes it and winds the worker down.",
        });
      }
      return;
    }
    const result = await archiveThread(props.threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Failed to archive thread", squashAtomCommandFailure(result));
    }
  };

  const snoozeUntil = (until: string | null) => {
    if (card !== null) void act(card, { type: "snooze", until });
  };

  const presets = snoozeMenuOpen
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId)
    : [];

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="rounded-2xl border border-border bg-card shadow-xs/5 focus-within:border-ring">
      {card?.item.refused === undefined ? null : (
        <p className="px-3 pt-2.5 text-xs text-warning-foreground">
          FirstMate could not {REFUSED_ACTION[card.item.refused.type]}
          {card.item.refused.message === undefined ? "." : `: ${card.item.refused.message}`}
        </p>
      )}
      <textarea
        aria-label="Reply to FirstMate about this thread"
        className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="Reply to FirstMate about this thread…"
        value={text}
        disabled={!permitted}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3">
        {card === null ? null : card.snoozed !== null ? (
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={!permitted}
            onClick={() => void act(card, { type: "unsnooze" })}
          >
            <AlarmClockOffIcon aria-hidden />
            Bring back
          </Button>
        ) : (
          <Group>
            <Button
              variant="outline"
              size="sm"
              disabled={!permitted}
              onClick={() => snoozeUntil(null)}
            >
              <AlarmClockIcon aria-hidden />
              Snooze
            </Button>
            <GroupSeparator />
            <Menu open={snoozeMenuOpen} onOpenChange={setSnoozeMenuOpen}>
              <MenuTrigger
                disabled={!permitted}
                render={<Button variant="outline" size="icon-sm" aria-label="Snooze until…" />}
              >
                <ChevronDownIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup side="top" align="start">
                {presets.map((preset) => (
                  <MenuItem
                    key={preset.id}
                    onClick={() => {
                      const picked = pickSnoozePreset(
                        presets,
                        preset.id,
                        timestampFormat,
                        environmentId,
                      );
                      if (picked) snoozeUntil(picked.snoozedUntil);
                    }}
                  >
                    {preset.label}
                    <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
                  </MenuItem>
                ))}
                {presets.length > 0 ? <MenuSeparator /> : null}
                <MenuItem
                  onClick={async () => {
                    const choice = await requestCustomSnooze();
                    if (choice) snoozeUntil(choice.snoozedUntil);
                  }}
                >
                  Custom…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </Group>
        )}
        <Button variant="ghost-muted" size="sm" onClick={() => void archive()}>
          <ArchiveIcon aria-hidden />
          Archive
        </Button>
        <span className="ms-auto" />
        {card?.label === "Replied" ? (
          <span className="text-xs text-muted-foreground">Replied</span>
        ) : null}
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
