import { type ProjectId, UsageWorkGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const sameWorkGroups = Schema.toEquivalence(Schema.Array(UsageWorkGroup));

/** The groups last sent, until the server's settings hold them. */
export function unsavedWorkGroups(
  saved: readonly UsageWorkGroup[],
  sent: readonly UsageWorkGroup[] | null,
): readonly UsageWorkGroup[] | null {
  return sent === null || sameWorkGroups(saved, sent) ? null : sent;
}

/** The group a project counts to: the first that lists it, as the server reads them. */
export function groupOfProject(
  groups: readonly UsageWorkGroup[],
  projectId: ProjectId,
): string | null {
  return groups.find((group) => group.projectIds.includes(projectId))?.name ?? null;
}

/** A group without `member` among its hidden members; a member that moves starts shown. */
function unhide(group: UsageWorkGroup, member: string): UsageWorkGroup {
  const { hiddenMembers = [], ...rest } = group;
  const kept = hiddenMembers.filter((key) => key !== member);
  return kept.length === 0 ? rest : { ...rest, hiddenMembers: kept };
}

/** Moves a project into one group, or into none (Other) with null. */
export function assignProject(
  groups: readonly UsageWorkGroup[],
  projectId: ProjectId,
  groupName: string | null,
): readonly UsageWorkGroup[] {
  return groups.map((group) => {
    const projectIds = group.projectIds.filter((id) => id !== projectId);
    return {
      ...unhide(group, projectId),
      projectIds: group.name === groupName ? [...projectIds, projectId] : projectIds,
    };
  });
}

/** The member key of a folder entry, as the server names it and `hiddenMembers` lists it. */
export const folderMemberKey = (folder: string) => `folder:${folder}`;

/** Whether the Usage page can open the group into its members; it can unless switched off. */
export function setGroupOpens(
  groups: readonly UsageWorkGroup[],
  name: string,
  opens: boolean,
): readonly UsageWorkGroup[] {
  return groups.map(({ opensIntoMembers: _opens, ...group }) =>
    group.name !== name
      ? _opens === false
        ? { ...group, opensIntoMembers: false }
        : group
      : opens
        ? group
        : { ...group, opensIntoMembers: false },
  );
}

/** Shows or hides a member's row in the group that holds it; a hidden member still counts. */
export function setMemberShown(
  groups: readonly UsageWorkGroup[],
  member: string,
  shown: boolean,
): readonly UsageWorkGroup[] {
  return groups.map((group) => {
    const holds =
      group.projectIds.some((id) => id === member) ||
      (group.folders ?? []).some((folder) => folderMemberKey(folder) === member);
    if (!holds) return group;
    const shownGroup = unhide(group, member);
    return shown
      ? shownGroup
      : {
          ...shownGroup,
          hiddenMembers: [...(group.hiddenMembers ?? []).filter((key) => key !== member), member],
        };
  });
}

/** Whether a member has a row of its own. */
export const memberShown = (groups: readonly UsageWorkGroup[], member: string) =>
  !groups.some((group) => group.hiddenMembers?.includes(member) === true);

/** Each folder entry with the group it counts to: the first that lists it, as the server reads them. */
export function folderEntries(
  groups: readonly UsageWorkGroup[],
): readonly { readonly folder: string; readonly group: string }[] {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const folder of group.folders ?? []) {
      if (!seen.has(folder)) seen.set(folder, group.name);
    }
  }
  return [...seen].map(([folder, group]) => ({ folder, group }));
}

/** A folder as an entry takes it, or null when it is not an absolute or `~` path. */
export function usableFolder(folder: string): string | null {
  const trimmed = folder.trim().replace(/(.)\/+$/, "$1");
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") ? trimmed : null;
}

/** Moves a folder entry into one group, or removes it with null. */
export function assignFolder(
  groups: readonly UsageWorkGroup[],
  folder: string,
  groupName: string | null,
): readonly UsageWorkGroup[] {
  return groups.map((group) => {
    const { folders: current = [], ...rest } = unhide(group, folderMemberKey(folder));
    const others = current.filter((entry) => entry !== folder);
    const folders = group.name === groupName ? [...others, folder] : others;
    return folders.length === 0 ? rest : { ...rest, folders };
  });
}

export function setGroupShared(
  groups: readonly UsageWorkGroup[],
  name: string,
  shared: boolean,
): readonly UsageWorkGroup[] {
  return groups.map(({ shared: wasShared, ...group }) =>
    (group.name === name ? shared : wasShared === true) ? { ...group, shared: true } : group,
  );
}

/** A trimmed name no other group has, or null when the name cannot be used. */
export function usableGroupName(
  groups: readonly UsageWorkGroup[],
  name: string,
  current: string | null,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const taken = groups.some(
    (group) => group.name !== current && group.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? null : trimmed;
}

export function renameGroup(
  groups: readonly UsageWorkGroup[],
  from: string,
  to: string,
): readonly UsageWorkGroup[] {
  return groups.map((group) => (group.name === from ? { ...group, name: to } : group));
}

/** The next free "Group N" name, so adding never collides. */
export function newGroupName(groups: readonly UsageWorkGroup[], base: string): string {
  for (let index = groups.length + 1; ; index += 1) {
    const name = `${base} ${index}`;
    if (usableGroupName(groups, name, null) !== null) return name;
  }
}

/** Removing a group sends its projects to Other and drops its folders. */
export function removeGroup(
  groups: readonly UsageWorkGroup[],
  name: string,
): readonly UsageWorkGroup[] {
  return groups.filter((group) => group.name !== name);
}
