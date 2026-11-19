import type { ProjectId, UsageWorkGroup } from "@t3tools/contracts";

/** The group a project counts to: the first that lists it, as the server reads them. */
export function groupOfProject(
  groups: readonly UsageWorkGroup[],
  projectId: ProjectId,
): string | null {
  return groups.find((group) => group.projectIds.includes(projectId))?.name ?? null;
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
      name: group.name,
      projectIds: group.name === groupName ? [...projectIds, projectId] : projectIds,
    };
  });
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

/** Removing a group sends its projects to Other. */
export function removeGroup(
  groups: readonly UsageWorkGroup[],
  name: string,
): readonly UsageWorkGroup[] {
  return groups.filter((group) => group.name !== name);
}
