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

/**
 * A group with `member` off both its member lists and without its colour, so a member that moves
 * starts shown in a group that hides and hidden in one that shows only its list. A show list
 * stays, even empty.
 */
function forget(group: UsageWorkGroup, member: string): UsageWorkGroup {
  const { hiddenMembers = [], shownMembers, ...rest } = withColor(group, member, null);
  const hidden = hiddenMembers.filter((key) => key !== member);
  return {
    ...rest,
    ...(hidden.length === 0 ? {} : { hiddenMembers: hidden }),
    ...(shownMembers === undefined
      ? {}
      : { shownMembers: shownMembers.filter((key) => key !== member) }),
  };
}

function withColor(group: UsageWorkGroup, member: string, color: string | null): UsageWorkGroup {
  const { memberColors = {}, ...rest } = group;
  const { [member]: _old, ...others } = memberColors;
  const colors = color === null ? others : { ...others, [member]: color };
  return Object.keys(colors).length === 0 ? rest : { ...rest, memberColors: colors };
}

/** The members a group holds, as the server keys them. */
const membersOf = (group: UsageWorkGroup) => [
  ...group.projectIds,
  ...(group.folders ?? []).map((folder) => folderMemberKey(folder)),
];

/** Moves a project into one group, or into none (Other) with null; its own colour goes with it. */
export function assignProject(
  groups: readonly UsageWorkGroup[],
  projectId: ProjectId,
  groupName: string | null,
): readonly UsageWorkGroup[] {
  const color = memberColor(groups, projectId);
  return groups.map((group) => {
    const projectIds = group.projectIds.filter((id) => id !== projectId);
    const kept = { ...forget(group, projectId), projectIds };
    return group.name === groupName
      ? withColor({ ...kept, projectIds: [...projectIds, projectId] }, projectId, color)
      : kept;
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
    if (!membersOf(group).includes(member)) return group;
    if (group.shownMembers !== undefined) {
      const others = group.shownMembers.filter((key) => key !== member);
      return { ...group, shownMembers: shown ? [...others, member] : others };
    }
    const { hiddenMembers = [], ...rest } = group;
    const others = hiddenMembers.filter((key) => key !== member);
    const hidden = shown ? others : [...others, member];
    return hidden.length === 0 ? rest : { ...rest, hiddenMembers: hidden };
  });
}

/** A member's own colour in the group that holds it, or null when it takes the group's palette. */
export function memberColor(groups: readonly UsageWorkGroup[], member: string): string | null {
  return groups.find((group) => membersOf(group).includes(member))?.memberColors?.[member] ?? null;
}

/** Gives a member its own colour in the group that holds it, or the group's palette with null. */
export function setMemberColor(
  groups: readonly UsageWorkGroup[],
  member: string,
  color: string | null,
): readonly UsageWorkGroup[] {
  return groups.map((group) =>
    membersOf(group).includes(member) ? withColor(group, member, color) : group,
  );
}

/** Whether a member has a row of its own: on its group's show list, or off its hide list. */
export function memberShown(groups: readonly UsageWorkGroup[], member: string): boolean {
  const group = groups.find((entry) => membersOf(entry).includes(member));
  if (group === undefined) return true;
  return group.shownMembers !== undefined
    ? group.shownMembers.includes(member)
    : group.hiddenMembers?.includes(member) !== true;
}

/**
 * Whether a group lists the members to show (on) or the members to hide (off). Switching keeps
 * the same members shown.
 */
export function setGroupShowsOnly(
  groups: readonly UsageWorkGroup[],
  name: string,
  only: boolean,
): readonly UsageWorkGroup[] {
  return groups.map((group) => {
    if (group.name !== name || (group.shownMembers !== undefined) === only) return group;
    const { hiddenMembers: _hidden, shownMembers: _shown, ...rest } = group;
    const shown = membersOf(group).filter((member) => memberShown([group], member));
    const hidden = membersOf(group).filter((member) => !shown.includes(member));
    return only
      ? { ...rest, shownMembers: shown }
      : hidden.length === 0
        ? rest
        : { ...rest, hiddenMembers: hidden };
  });
}

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

/** Moves a folder entry into one group, or removes it with null; its own colour goes with it. */
export function assignFolder(
  groups: readonly UsageWorkGroup[],
  folder: string,
  groupName: string | null,
): readonly UsageWorkGroup[] {
  const member = folderMemberKey(folder);
  const color = memberColor(groups, member);
  return groups.map((group) => {
    const { folders: current = [], ...rest } = forget(group, member);
    const others = current.filter((entry) => entry !== folder);
    if (group.name === groupName)
      return withColor({ ...rest, folders: [...others, folder] }, member, color);
    return others.length === 0 ? rest : { ...rest, folders: others };
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
