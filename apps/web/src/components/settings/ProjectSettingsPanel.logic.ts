import type { ProjectIconOverride } from "@t3tools/contracts";
import { msg } from "gt-react";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { Project } from "../../types";

export const SCRATCH_PROJECT_TITLE = "No project";
const SCRATCH_PROJECT_ICON = {
  kind: "lucide",
  name: "message-square-dashed",
  color: "gray",
} as const satisfies ProjectIconOverride;

export function scopeProjectSettingsGroup(
  group: SidebarProjectSnapshot,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  const representative =
    members.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? members[0]!;
  return { ...group, ...representative, memberProjects: members };
}

export function projectGroupTitleNeedsUpdate(
  members: ReadonlyArray<Pick<Project, "title" | "hasCustomTitle">>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return (
    wasEdited &&
    members.some((member) => member.title !== nextTitle || member.hasCustomTitle !== true)
  );
}

export function defaultProjectIcon(project: Pick<Project, "isScratch">) {
  return { faviconPath: null, projectIcon: project.isScratch ? SCRATCH_PROJECT_ICON : null };
}

export function hasDefaultProjectIcon(
  project: Pick<Project, "isScratch" | "faviconPath" | "projectIcon">,
): boolean {
  if (project.faviconPath != null) return false;
  const icon = project.projectIcon ?? null;
  if (!project.isScratch) return icon === null;
  return (
    icon?.kind === "lucide" &&
    icon.name === SCRATCH_PROJECT_ICON.name &&
    icon.color === SCRATCH_PROJECT_ICON.color
  );
}

/** Typed quiet minutes: whole minutes, null for empty or zero (off), undefined when unreadable. */
export function parseQuietMinutes(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes)) return undefined;
  return minutes <= 0 ? null : Math.max(1, Math.round(minutes));
}

export const QUIET_CLEAR_MODES = ["off", "cache", "minutes"] as const;
export type QuietClearMode = (typeof QUIET_CLEAR_MODES)[number];
export const QUIET_CLEAR_MODE_LABELS: Record<QuietClearMode, string> = {
  off: msg("Off", { $context: "setting is disabled" }),
  cache: msg("When Claude's cache expires"),
  minutes: msg("After a set time"),
};
export function isQuietClearMode(value: unknown): value is QuietClearMode {
  return QUIET_CLEAR_MODES.includes(value as QuietClearMode);
}
