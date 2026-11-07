import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  type EnvironmentId,
  type Objectives,
  type ScopedThreadRef,
  type ServerSettings,
  type ThreadDecisionAttachment,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";

type DecisionShell = ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    | "decisionOf"
    | "decisionUpdatedAt"
    | "createdAt"
    | "archivedAt"
    | "settledOverride"
    | "snoozedUntil"
    | "snoozedAt"
  >;

export interface NeedsMeGroups<T> {
  readonly open: T[];
  readonly later: T[];
  readonly scheduled: T[];
}

const ms = (iso: string | null | undefined) => (iso == null ? 0 : Date.parse(iso) || 0);

/** Whether the Needs me tab has a row for this thread: a decision not archived or settled. */
export function isNeedsMeListed(
  thread: Pick<EnvironmentThreadShell, "decisionOf" | "archivedAt" | "settledOverride">,
): boolean {
  return (
    thread.decisionOf !== undefined &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled"
  );
}

/**
 * FirstMate's decision threads as the Needs me tab lists them: open ones newest update first,
 * undated snoozes under Later most recently snoozed first, dated ones under Scheduled soonest
 * first. Settled ones are not listed, even snoozed.
 */
export function groupNeedsMeDecisions<T extends DecisionShell>(
  threads: readonly T[],
  now: Date,
): NeedsMeGroups<T> {
  const nowIso = now.toISOString();
  const open: T[] = [];
  const later: T[] = [];
  const scheduled: T[] = [];
  for (const thread of threads) {
    if (!isNeedsMeListed(thread)) continue;
    if (!effectiveSnoozed(thread, { now: nowIso })) open.push(thread);
    else (thread.snoozedUntil == null ? later : scheduled).push(thread);
  }
  return {
    open: open.toSorted(
      (left, right) =>
        ms(right.decisionUpdatedAt ?? right.createdAt) -
        ms(left.decisionUpdatedAt ?? left.createdAt),
    ),
    later: later.toSorted((left, right) => ms(right.snoozedAt) - ms(left.snoozedAt)),
    scheduled: scheduled.toSorted((left, right) => ms(left.snoozedUntil) - ms(right.snoozedUntil)),
  };
}

/**
 * When the call was first raised: `decision.since` (FirstMate's hold start), else its raised
 * entry, as the shell's `decisionSince` carries them, else when the thread was made.
 */
function decisionRaisedAt(
  thread: Pick<EnvironmentThreadShell, "decisionSince" | "createdAt">,
): string {
  return thread.decisionSince ?? thread.createdAt;
}

/**
 * Where a row's age counts from: FirstMate's latest real change, else when the call began
 * waiting. Rewording the original context is neither, so it keeps its age.
 */
export function decisionAgeTimestamp(
  thread: Pick<EnvironmentThreadShell, "decisionChangedAt" | "decisionSince" | "createdAt">,
): string {
  const { decisionChangedAt } = thread;
  const since = decisionRaisedAt(thread);
  return decisionChangedAt !== undefined && ms(decisionChangedAt) > ms(since)
    ? decisionChangedAt
    : since;
}

const dayLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
export const formatDay = (iso: string) => dayLabel.format(Date.parse(iso));
/** A `YYYY-MM-DD` day as the same label, read in local time so it never shifts a day. */
export const formatCalendarDay = (day: string) => formatDay(`${day}T00:00:00`);

/** The gray detail on a row: Needs you its age, Later the day it was raised, Scheduled its wake day. */
export function needsMeRowDetail(
  thread: Pick<
    EnvironmentThreadShell,
    "decisionChangedAt" | "decisionSince" | "createdAt" | "snoozedUntil"
  >,
  section: keyof NeedsMeGroups<unknown>,
  nowMs: number,
): string {
  switch (section) {
    case "open":
      return formatRelativeTimeLabel(decisionAgeTimestamp(thread), nowMs);
    case "later":
      return `raised ${formatDay(decisionRaisedAt(thread))}`;
    case "scheduled":
      return thread.snoozedUntil == null ? "" : `back ${formatDay(thread.snoozedUntil)}`;
  }
}

const OBJECTIVE_BULLET = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;

/**
 * One markdown entry per objective: each top-level bullet with its continuation lines. Markdown
 * with no bullets is a single entry.
 */
export function splitObjectives(markdown: string): ReadonlyArray<string> {
  const items: string[][] = [];
  const preamble: string[] = [];
  for (const line of markdown.split("\n")) {
    if (OBJECTIVE_BULLET.test(line)) {
      items.push([line.replace(OBJECTIVE_BULLET, "")]);
    } else {
      (items.at(-1) ?? preamble).push(line);
    }
  }
  if (items.length === 0) return markdown.trim() === "" ? [] : [markdown.trim()];
  const entries = items.map((lines) => lines.join("\n").trim());
  const intro = preamble.join("\n").trim();
  return (intro === "" ? entries : [intro, ...entries]).filter((entry) => entry !== "");
}

/**
 * The objectives the Bridge shows: the host chat's environment's, else the first connected
 * environment that has some. FirstMate normally sets them on one environment only.
 */
export function bridgeObjectives(
  settingsByEnvironment: ReadonlyMap<
    EnvironmentId,
    { readonly settings: Pick<ServerSettings, "objectives"> }
  >,
  hostEnvironmentId: EnvironmentId,
): Objectives | null {
  const host = settingsByEnvironment.get(hostEnvironmentId)?.settings.objectives;
  if (host != null) return host;
  for (const config of settingsByEnvironment.values()) {
    if (config.settings.objectives != null) return config.settings.objectives;
  }
  return null;
}

/**
 * How a decision's Markdown links files. A click opens the file in the panel the user is looking
 * at, the host chat's, so paths are made relative to that chat's workspace; relative links still
 * resolve against the decision's own project. Another environment's host cannot read its files.
 */
export function decisionMarkdownScope(input: {
  readonly decisionRef: ScopedThreadRef;
  readonly hostRef: ScopedThreadRef;
  readonly decisionRoot: string | undefined;
  readonly hostRoot: string | undefined;
}): {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly imageBaseDir: string | undefined;
} {
  const { decisionRoot } = input;
  if (input.hostRef.environmentId !== input.decisionRef.environmentId) {
    return { threadRef: input.decisionRef, cwd: decisionRoot, imageBaseDir: decisionRoot };
  }
  return {
    threadRef: input.hostRef,
    cwd: input.hostRoot ?? decisionRoot,
    imageBaseDir: decisionRoot ?? input.hostRoot,
  };
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
