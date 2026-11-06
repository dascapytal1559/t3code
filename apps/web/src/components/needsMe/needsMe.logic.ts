import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import { CommandId, type ThreadDecisionAttachment } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

type DecisionShell = ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    | "decisionOf"
    | "decisionUpdatedAt"
    | "createdAt"
    | "archivedAt"
    | "settledOverride"
    | "settledAt"
    | "snoozedUntil"
    | "snoozedAt"
  >;

export interface NeedsMeGroups<T> {
  readonly open: T[];
  readonly later: T[];
  readonly answeredToday: T[];
}

const ms = (iso: string | null | undefined) => (iso == null ? 0 : Date.parse(iso) || 0);

/**
 * FirstMate's decision threads as the Needs me tab lists them: open ones newest update first,
 * snoozed ones under Later by wake date (undated last), and ones settled today, which leave
 * when the local day ends.
 */
export function groupNeedsMeDecisions<T extends DecisionShell>(
  threads: readonly T[],
  now: Date,
): NeedsMeGroups<T> {
  const nowIso = now.toISOString();
  const today = now.toDateString();
  const open: T[] = [];
  const later: T[] = [];
  const answeredToday: T[] = [];
  for (const thread of threads) {
    if (thread.decisionOf === undefined || thread.archivedAt !== null) continue;
    if (effectiveSnoozed(thread, { now: nowIso })) later.push(thread);
    else if (thread.settledOverride !== "settled") open.push(thread);
    else if (thread.settledAt !== null && new Date(thread.settledAt).toDateString() === today) {
      answeredToday.push(thread);
    }
  }
  return {
    open: open.toSorted(
      (left, right) =>
        ms(right.decisionUpdatedAt ?? right.createdAt) -
        ms(left.decisionUpdatedAt ?? left.createdAt),
    ),
    later: later.toSorted((left, right) => {
      if (left.snoozedUntil == null || right.snoozedUntil == null) {
        if (left.snoozedUntil != null) return -1;
        if (right.snoozedUntil != null) return 1;
        return ms(right.snoozedAt) - ms(left.snoozedAt);
      }
      return ms(left.snoozedUntil) - ms(right.snoozedUntil);
    }),
    answeredToday: answeredToday.toSorted(
      (left, right) => ms(right.settledAt) - ms(left.settledAt),
    ),
  };
}

/** When the call began waiting on the user, not its latest edit, so rewording keeps its age. */
export function decisionAgeTimestamp(
  thread: Pick<EnvironmentThreadShell, "decisionSince" | "createdAt">,
): string {
  return thread.decisionSince ?? thread.createdAt;
}

/** "new" until the decision is first opened, then "updated" while FirstMate changed it since. */
export function decisionMark(
  thread: Pick<EnvironmentThreadShell, "decisionUpdatedAt">,
  lastVisitedAt: string | undefined,
): "new" | "updated" | null {
  if (lastVisitedAt === undefined) return "new";
  return ms(thread.decisionUpdatedAt) > ms(lastVisitedAt) ? "updated" : null;
}

const PICTURE_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

const escapeLabel = (label: string) => label.replace(/[[\]\\]/g, "\\$&");

/**
 * A decision's attachments as Markdown, so the chat's own renderer draws pictures and opens
 * reports and links the way it does in a message. Paths resolve against the project folder.
 */
export function decisionAttachmentsMarkdown(
  attachments: ReadonlyArray<ThreadDecisionAttachment>,
): string | null {
  if (attachments.length === 0) return null;
  const pictures: string[] = [];
  const links: string[] = [];
  for (const attachment of attachments) {
    const label = escapeLabel(
      attachment.label ?? attachment.path.split("/").at(-1) ?? attachment.kind,
    );
    const target = `<${attachment.path.replace(/[<>]/g, encodeURIComponent)}>`;
    if (PICTURE_PATH.test(attachment.path)) pictures.push(`![${label}](${target})`);
    else links.push(`- [${label}](${target})`);
  }
  return [...pictures, ...(links.length === 0 ? [] : [links.join("\n")])].join("\n\n");
}

export function decisionReplyCommandId(): CommandId {
  return CommandId.make(`web:decision-reply:${randomUUID()}`);
}
