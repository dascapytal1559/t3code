import {
  CommandId,
  decisionChangedAt,
  decisionSince,
  decisionUpdatedAt,
  type DecisionAttachment,
  type EnvironmentId,
  type Objectives,
  type ScopedThreadRef,
  type ServerSettings,
  type StoredDecision,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";

interface ListedDecision {
  readonly decision: Pick<StoredDecision, "entries" | "since" | "wakeAt" | "answered">;
}

export interface NeedsMeGroups<T> {
  readonly open: T[];
  readonly scheduled: T[];
}

const ms = (iso: string | null | undefined) => (iso == null ? 0 : Date.parse(iso) || 0);

/** One decision's key in the tab: ids are FirstMate's own, so unique per environment only. */
export const bridgeDecisionKey = (item: {
  readonly environmentId: EnvironmentId;
  readonly decision: Pick<StoredDecision, "id">;
}) => `${item.environmentId}:${item.decision.id}`;

/**
 * FirstMate's decisions as the Bridge tab lists them: those waiting now newest update first, and
 * those with a return date still ahead under Scheduled, soonest first. One the user has answered
 * is not listed until FirstMate changes it.
 */
export function groupNeedsMeDecisions<T extends ListedDecision>(
  decisions: readonly T[],
  now: Date,
): NeedsMeGroups<T> {
  const nowMs = now.getTime();
  const open: T[] = [];
  const scheduled: T[] = [];
  for (const item of decisions) {
    if (item.decision.answered !== undefined) continue;
    (ms(item.decision.wakeAt) > nowMs ? scheduled : open).push(item);
  }
  const updatedMs = (item: T) => ms(decisionUpdatedAt(item.decision) ?? item.decision.since);
  return {
    open: open.toSorted((left, right) => updatedMs(right) - updatedMs(left)),
    scheduled: scheduled.toSorted(
      (left, right) => ms(left.decision.wakeAt) - ms(right.decision.wakeAt),
    ),
  };
}

/**
 * Where a row's age counts from: FirstMate's latest real change, else when the decision began
 * waiting (its `since`, else its raised entry). Rewording the original context is neither, so it
 * keeps its age. Null for a decision with no entries and no `since`.
 */
export function decisionAgeTimestamp(
  decision: Pick<StoredDecision, "entries" | "since">,
): string | null {
  const changedAt = decisionChangedAt(decision);
  const since = decisionSince(decision);
  return changedAt !== null && ms(changedAt) > ms(since) ? changedAt : since;
}

const dayLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
export const formatDay = (iso: string) => dayLabel.format(Date.parse(iso));

/** The gray detail on a row: Needs you its age, Scheduled its return day. */
export function needsMeRowDetail(
  decision: Pick<StoredDecision, "entries" | "since" | "wakeAt">,
  section: keyof NeedsMeGroups<unknown>,
  nowMs: number,
): string {
  switch (section) {
    case "open": {
      const age = decisionAgeTimestamp(decision);
      return age === null ? "" : formatRelativeTimeLabel(age, nowMs);
    }
    case "scheduled":
      return decision.wakeAt === undefined ? "" : `back ${formatDay(decision.wakeAt)}`;
  }
}

const OBJECTIVE_BULLET = /^(\s{0,3})(?:[-*+]|\d+[.)])\s+/;

/**
 * One markdown entry per objective: each top-level bullet with its continuation lines. Markdown
 * with no bullets is a single entry. As in CommonMark, a bullet indented to the current item's
 * text is nested in it.
 */
export function splitObjectives(markdown: string): ReadonlyArray<string> {
  const items: string[][] = [];
  const preamble: string[] = [];
  let contentIndent = 0;
  for (const line of markdown.split("\n")) {
    const bullet = OBJECTIVE_BULLET.exec(line);
    if (bullet !== null && (items.length === 0 || bullet[1]!.length < contentIndent)) {
      contentIndent = bullet[0].length;
      items.push([line.slice(contentIndent)]);
    } else {
      (items.at(-1) ?? preamble).push(line);
    }
  }
  if (items.length === 0) return markdown.trim() === "" ? [] : [markdown.trim()];
  const entries = items.map((lines) => lines.join("\n").trim());
  const intro = preamble.join("\n").trim();
  return (intro === "" ? entries : [intro, ...entries]).filter((entry) => entry !== "");
}

const OBJECTIVE_LEAD = /^\*\*(.+?)\*\*\s*(?:[:—–-]\s*)?([\s\S]*)$/;

/**
 * An objective's bold lead as its name and the rest, past a dash or colon, as its text: the
 * `**Name** — text` shape FirstMate writes. An entry with no bold lead is all text.
 */
export function parseObjective(entry: string): { readonly name?: string; readonly text: string } {
  const match = OBJECTIVE_LEAD.exec(entry);
  const name = match?.[1]?.trim().replace(/:$/, "");
  if (match === null || name === undefined || name === "") return { text: entry.trim() };
  return { name, text: (match[2] ?? "").trim() };
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
 * resolve against FirstMate's project, `decisionRoot`. Another environment's host cannot read its
 * files, so there the scope stays FirstMate's own chat.
 */
export function decisionMarkdownScope(input: {
  /** FirstMate's chat, in the decision's environment. */
  readonly coordinatorRef: ScopedThreadRef;
  readonly hostRef: ScopedThreadRef;
  readonly decisionRoot: string | undefined;
  readonly hostRoot: string | undefined;
}): {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly imageBaseDir: string | undefined;
} {
  const { decisionRoot } = input;
  if (input.hostRef.environmentId !== input.coordinatorRef.environmentId) {
    return { threadRef: input.coordinatorRef, cwd: decisionRoot, imageBaseDir: decisionRoot };
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
  attachments: ReadonlyArray<DecisionAttachment>,
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
