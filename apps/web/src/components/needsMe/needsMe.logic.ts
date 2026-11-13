import {
  CommandId,
  type DecisionsState,
  type EnvironmentId,
  type ServerSettings,
  type StoredDecision,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

const ms = (iso: string | null | undefined) => (iso == null ? 0 : Date.parse(iso) || 0);

type Snooze = NonNullable<StoredDecision["snoozed"]>;

/** Whether a snooze still holds: undated until brought back, dated until its time passes. */
export const isSnoozedAt = (snoozed: Snooze | undefined, nowMs: number): snoozed is Snooze =>
  snoozed !== undefined && (snoozed.until === null || ms(snoozed.until) > nowMs);

/**
 * The items as the user should see them now: FirstMate's list with the user's actions it has not
 * acknowledged applied over it, so a tap moves the item at once. Archived items are left out.
 */
export function effectiveDecisions(
  state: Pick<DecisionsState, "decisions" | "actions">,
): StoredDecision[] {
  const byId = new Map(state.decisions.map((item) => [item.id, item] as const));
  for (const action of state.actions) {
    const item = byId.get(action.itemId);
    if (item === undefined) continue;
    switch (action.type) {
      case "snooze":
        byId.set(item.id, { ...item, snoozed: { at: action.at, until: action.until ?? null } });
        break;
      case "unsnooze": {
        const { snoozed: _snoozed, ...awake } = item;
        byId.set(item.id, awake);
        break;
      }
      case "archive":
      case "thread-archived":
        byId.delete(item.id);
        break;
      case "thread-unarchived":
        break;
    }
  }
  return [...byId.values()];
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
 * An objective's one-line title and the body it expands to. Without a name, the first line is the
 * title and the whole entry the body; a body that adds nothing to the title is empty.
 */
export function objectiveRow(entry: string): { readonly title: string; readonly body: string } {
  const { name, text } = parseObjective(entry);
  if (name !== undefined) return { title: name, body: text };
  const title = text.split("\n", 1)[0]!.trim();
  return { title, body: text === title ? "" : text };
}

/**
 * The objectives or routing table the Bridge shows: the host chat's environment's, else the first
 * connected environment that has one. FirstMate normally sets them on one environment only.
 */
export function bridgeSetting<K extends "objectives" | "modelRouting">(
  settingsByEnvironment: ReadonlyMap<EnvironmentId, { readonly settings: Pick<ServerSettings, K> }>,
  hostEnvironmentId: EnvironmentId,
  key: K,
): ServerSettings[K] | null {
  const host = settingsByEnvironment.get(hostEnvironmentId)?.settings[key];
  if (host != null) return host;
  for (const config of settingsByEnvironment.values()) {
    if (config.settings[key] != null) return config.settings[key];
  }
  return null;
}

export function decisionReplyCommandId(): CommandId {
  return CommandId.make(`web:decision-reply:${randomUUID()}`);
}
