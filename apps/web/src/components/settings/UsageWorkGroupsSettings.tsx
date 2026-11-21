import type { EnvironmentId, UsageWorkGroup, UsageWorkMemberLabel } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { environmentProjects } from "../../state/projects";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { OTHER_WORK_LABEL } from "../usage/usageSplits";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  assignFolder,
  assignProject,
  folderEntries,
  folderMemberKey,
  groupOfProject,
  memberColor,
  memberShown,
  newGroupName,
  removeGroup,
  renameGroup,
  setGroupOpens,
  setGroupShowsOnly,
  setGroupShared,
  setMemberColor,
  setMemberShown,
  unsavedWorkGroups,
  usableFolder,
  usableGroupName,
} from "./UsageWorkGroupsSettings.logic";

const OTHER = "";

/** Names the kinds of work the Usage page splits by, and puts this environment's projects in them. */
export function UsageWorkGroupsSettings({
  environmentId,
  groups: savedGroups,
  shareOther,
  memberLabel,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly groups: readonly UsageWorkGroup[];
  readonly shareOther: boolean;
  readonly memberLabel: UsageWorkMemberLabel;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId))
    .filter((project) => project.archivedAt == null)
    .toSorted((a, b) => a.title.localeCompare(b.title));
  const [sent, setSent] = useState<readonly UsageWorkGroup[] | null>(null);
  const unsaved = unsavedWorkGroups(savedGroups, sent);
  if (unsaved !== sent) setSent(unsaved);
  const groups = unsaved ?? savedGroups;
  const save = (next: readonly UsageWorkGroup[]) => {
    setSent(next);
    updateSettings(
      { usageWorkGroups: next },
      { onFailed: () => setSent((current) => (current === next ? null : current)) },
    );
  };
  // A member gets a Shown switch and a colour when its group opens into members on the Usage page.
  const opensFor = (groupName: string | null) => {
    const group = groups.find((entry) => entry.name === groupName);
    return group !== undefined && group.shared !== true && group.opensIntoMembers !== false;
  };
  const memberControls = (member: string, name: string) => (
    <>
      <MemberColorInput
        color={memberColor(groups, member)}
        readOnly={readOnly}
        label={gt("Color of {member} on the Usage page", { member: name })}
        onChange={(color) => save(setMemberColor(groups, member, color))}
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <T>Shown</T>
        <Switch
          size="sm"
          checked={memberShown(groups, member)}
          disabled={readOnly}
          aria-label={gt("Show {member} in its kind of work", { member: name })}
          onCheckedChange={(checked) => save(setMemberShown(groups, member, Boolean(checked)))}
        />
      </label>
    </>
  );

  return (
    <SettingsSection
      {...searchableSetting("usage-work-groups")}
      headerAction={
        readOnly ? null : (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              save([...groups, { name: newGroupName(groups, gt("Group")), projectIds: [] }])
            }
          >
            <PlusIcon className="size-3" aria-hidden />
            <T>Add group</T>
          </Button>
        )
      }
    >
      <SettingsRow
        title={gt("Groups")}
        description={gt(
          "The Usage page can split usage by these kinds of work. Usage in a project with no group, or in no project, counts as Other.",
        )}
      />
      {groups.map((group) => (
        <SettingsRow
          key={group.name}
          title={
            <GroupNameInput
              name={group.name}
              readOnly={readOnly}
              onRename={(name) => {
                const usable = usableGroupName(groups, name, group.name);
                if (usable !== null && usable !== group.name)
                  save(renameGroup(groups, group.name, usable));
              }}
            />
          }
          description={gt(
            "{projects, plural, one {# project} other {# projects}}, {folders, plural, one {# folder} other {# folders}}",
            { projects: group.projectIds.length, folders: group.folders?.length ?? 0 },
          )}
          control={
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <T>Members</T>
                <Switch
                  size="sm"
                  checked={group.shared !== true && group.opensIntoMembers !== false}
                  disabled={readOnly || group.shared === true}
                  aria-label={gt(
                    "Let {group} open into its projects and folders on the Usage page",
                    {
                      group: group.name,
                    },
                  )}
                  onCheckedChange={(checked) =>
                    save(setGroupOpens(groups, group.name, Boolean(checked)))
                  }
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <T>Only shown</T>
                <Switch
                  size="sm"
                  checked={group.shownMembers !== undefined}
                  disabled={readOnly || group.shared === true || group.opensIntoMembers === false}
                  aria-label={gt(
                    "Give rows only to the members of {group} marked Shown; new members start hidden",
                    { group: group.name },
                  )}
                  onCheckedChange={(checked) =>
                    save(setGroupShowsOnly(groups, group.name, Boolean(checked)))
                  }
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <T>Shared</T>
                <Switch
                  size="sm"
                  checked={group.shared === true}
                  disabled={readOnly}
                  aria-label={gt("Share {group} across the other groups", { group: group.name })}
                  onCheckedChange={(checked) =>
                    save(setGroupShared(groups, group.name, Boolean(checked)))
                  }
                />
              </label>
              {readOnly ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => save(removeGroup(groups, group.name))}
                >
                  <T>Remove</T>
                </Button>
              )}
            </div>
          }
        />
      ))}
      <SettingsRow
        title={gt("Share Other")}
        description={gt(
          "Spread usage in no group across the groups that are not shared, as a shared group is, so the chart has no Other band.",
        )}
        control={
          <Switch
            checked={shareOther}
            disabled={readOnly}
            aria-label={gt("Share Other")}
            onCheckedChange={(checked) => updateSettings({ usageWorkShareOther: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title={gt("Name members by")}
        description={gt(
          "What a kind of work's projects are called when it opens on the Usage page: the project's name, or its repository's folder name. Two projects of one repository show as one.",
        )}
        control={
          <Select
            value={memberLabel}
            disabled={readOnly}
            onValueChange={(next) => {
              if (next === "project" || next === "repository") {
                updateSettings({ usageWorkMemberLabel: next });
              }
            }}
          >
            <SelectTrigger aria-label={gt("Name members by")} size="sm" className="w-full sm:w-40">
              <SelectValue>
                {memberLabel === "repository" ? gt("Repository") : gt("Project name")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="project">{gt("Project name")}</SelectItem>
              <SelectItem value="repository">{gt("Repository")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={gt("Folders")}
        description={gt(
          "A folder counts the usage in it and its subfolders, but not in worktrees elsewhere. Where a folder and a project both hold a session's folder, the closer one wins, and the folder on a tie.",
        )}
        control={
          readOnly || groups.length === 0 ? null : (
            <AddFolder
              groups={groups}
              onAdd={(folder, group) => save(assignFolder(groups, folder, group))}
            />
          )
        }
      />
      {folderEntries(groups).map((entry) => (
        <SettingsRow
          key={entry.folder}
          title={<span className="break-all">{entry.folder}</span>}
          control={
            <div className="flex items-center gap-2">
              {opensFor(entry.group)
                ? memberControls(folderMemberKey(entry.folder), entry.folder)
                : null}
              <GroupSelect
                groups={groups}
                value={entry.group}
                disabled={readOnly}
                label={gt("Kind of work for {folder}", { folder: entry.folder })}
                onChange={(group) => save(assignFolder(groups, entry.folder, group))}
              />
              {readOnly ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => save(assignFolder(groups, entry.folder, null))}
                >
                  <T>Remove</T>
                </Button>
              )}
            </div>
          }
        />
      ))}
      {projects.map((project) => {
        const current = groupOfProject(groups, project.id) ?? OTHER;
        return (
          <SettingsRow
            key={project.id}
            title={project.title}
            description={<span className="break-all">{project.workspaceRoot}</span>}
            control={
              <div className="flex items-center gap-3">
                {opensFor(current) ? memberControls(project.id, project.title) : null}
                <GroupSelect
                  groups={groups}
                  value={current}
                  withOther
                  disabled={readOnly}
                  label={gt("Kind of work for {project}", { project: project.title })}
                  onChange={(group) => save(assignProject(groups, project.id, group))}
                />
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

/**
 * A member's own colour, or a faded swatch while it takes the group's palette; the picker saves
 * once it closes, not on every step of a drag.
 */
function MemberColorInput({
  color,
  readOnly,
  label,
  onChange,
}: {
  readonly color: string | null;
  readonly readOnly: boolean;
  readonly label: string;
  readonly onChange: (color: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        key={color ?? ""}
        type="color"
        aria-label={label}
        disabled={readOnly}
        defaultValue={color ?? "#808080"}
        className={`size-5 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-default ${color === null ? "opacity-40" : ""}`}
        ref={(node) => {
          if (node === null) return;
          const commit = () => {
            if (node.value !== color) onChange(node.value);
          };
          node.addEventListener("change", commit);
          return () => node.removeEventListener("change", commit);
        }}
      />
      {color === null || readOnly ? null : (
        <Button size="xs" variant="ghost" onClick={() => onChange(null)}>
          <T>Reset</T>
        </Button>
      )}
    </div>
  );
}

/** Picks a group; with `withOther`, the empty value is Other and picking it gives null. */
function GroupSelect({
  groups,
  value,
  withOther = false,
  disabled,
  label,
  onChange,
}: {
  readonly groups: readonly UsageWorkGroup[];
  readonly value: string;
  readonly withOther?: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (group: string | null) => void;
}) {
  const m = useMessages();
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next === OTHER || next === null ? null : next)}
    >
      <SelectTrigger aria-label={label} size="sm" className="w-full sm:w-40">
        <SelectValue>{value === OTHER ? m(OTHER_WORK_LABEL) : value}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {withOther ? <SelectItem value={OTHER}>{m(OTHER_WORK_LABEL)}</SelectItem> : null}
        {groups.map((group) => (
          <SelectItem key={group.name} value={group.name}>
            {group.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A folder path on the environment's machine and the group it joins. */
function AddFolder({
  groups,
  onAdd,
}: {
  readonly groups: readonly UsageWorkGroup[];
  readonly onAdd: (folder: string, group: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const group = groups.some((entry) => entry.name === picked) ? picked! : groups[0]!.name;
  const folder = usableFolder(draft);
  const add = () => {
    if (folder === null) return;
    onAdd(folder, group);
    setDraft("");
  };
  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
      <Input
        aria-label={gt("Folder")}
        placeholder={gt("/path/to/folder")}
        size="sm"
        className="min-w-0 flex-1 sm:w-56"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
      <GroupSelect
        groups={groups}
        value={group}
        disabled={false}
        label={gt("Group for the new folder")}
        onChange={setPicked}
      />
      <Button size="xs" variant="outline" disabled={folder === null} onClick={add}>
        <PlusIcon className="size-3" aria-hidden />
        <T>Add folder</T>
      </Button>
    </div>
  );
}

function GroupNameInput({
  name,
  readOnly,
  onRename,
}: {
  readonly name: string;
  readonly readOnly: boolean;
  readonly onRename: (name: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(name);
  if (readOnly) return name;
  return (
    <Input
      aria-label={gt("Group name")}
      size="sm"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        onRename(draft);
        setDraft(name);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(name);
      }}
    />
  );
}
