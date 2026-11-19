import type { EnvironmentId, UsageWorkGroup } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { environmentProjects } from "../../state/projects";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { OTHER_WORK_LABEL } from "../usage/usageSplits";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  assignProject,
  groupOfProject,
  newGroupName,
  removeGroup,
  renameGroup,
  usableGroupName,
} from "./UsageWorkGroupsSettings.logic";

const OTHER = "";

/** Names the kinds of work the Usage page splits by, and puts this environment's projects in them. */
export function UsageWorkGroupsSettings({
  environmentId,
  groups,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly groups: readonly UsageWorkGroup[];
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId))
    .filter((project) => project.archivedAt == null)
    .toSorted((a, b) => a.title.localeCompare(b.title));
  const save = (next: readonly UsageWorkGroup[]) => updateSettings({ usageWorkGroups: next });

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
          description={gt("{count, plural, one {# project} other {# projects}}", {
            count: group.projectIds.length,
          })}
          control={
            readOnly ? null : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => save(removeGroup(groups, group.name))}
              >
                <T>Remove</T>
              </Button>
            )
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
              <Select
                value={current}
                disabled={readOnly}
                onValueChange={(value) =>
                  save(
                    assignProject(
                      groups,
                      project.id,
                      value === OTHER || value === null ? null : value,
                    ),
                  )
                }
              >
                <SelectTrigger
                  aria-label={gt("Kind of work for {project}", { project: project.title })}
                  size="sm"
                  className="w-full sm:w-40"
                >
                  <SelectValue>{current === OTHER ? m(OTHER_WORK_LABEL) : current}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={OTHER}>{m(OTHER_WORK_LABEL)}</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.name} value={group.name}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
    </SettingsSection>
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
