import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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
  setGroupOpens,
  setGroupShared,
  setGroupShowsOnly,
  setMemberColor,
  setMemberShown,
  unsavedWorkGroups,
  usableFolder,
  usableGroupName,
} from "./UsageWorkGroupsSettings.logic";

const app = ProjectId.make("app");
const trader = ProjectId.make("trader");
const groups = [
  { name: "Trading", projectIds: [trader] },
  { name: "Tooling", projectIds: [] },
];

describe("usage work groups", () => {
  it("keeps a project in one group at most, and sends it to Other with null", () => {
    const moved = assignProject(groups, trader, "Tooling");
    expect(moved).toEqual([
      { name: "Trading", projectIds: [] },
      { name: "Tooling", projectIds: [trader] },
    ]);
    expect(groupOfProject(moved, trader)).toBe("Tooling");
    expect(groupOfProject(assignProject(moved, trader, null), trader)).toBeNull();
    expect(groupOfProject(assignProject(groups, app, "Trading"), app)).toBe("Trading");
  });

  it("hides a member in the group that holds it, shows it again when it moves, and closes a group", () => {
    const withFolder = assignFolder(groups, "/work/main", "Tooling");
    const hidden = setMemberShown(
      setMemberShown(withFolder, trader, false),
      folderMemberKey("/work/main"),
      false,
    );
    expect(hidden.map((group) => group.hiddenMembers)).toEqual([[trader], ["folder:/work/main"]]);
    expect(memberShown(hidden, trader)).toBe(false);
    expect(memberShown(setMemberShown(hidden, trader, true), trader)).toBe(true);
    // A member that moves starts shown, wherever it goes, and keeps its own colour.
    const folder = folderMemberKey("/work/main");
    const colored = setMemberColor(setMemberColor(hidden, trader, "#1b4ed8"), folder, "#d9a747");
    expect(colored.map((group) => group.memberColors)).toEqual([
      { [trader]: "#1b4ed8" },
      { [folder]: "#d9a747" },
    ]);
    const moved = assignFolder(assignProject(colored, trader, "Tooling"), "/work/main", "Trading");
    expect(moved.map((group) => group.hiddenMembers)).toEqual([undefined, undefined]);
    expect(moved.map((group) => group.memberColors)).toEqual([
      { [folder]: "#d9a747" },
      { [trader]: "#1b4ed8" },
    ]);
    expect(memberColor(setMemberColor(moved, trader, null), trader)).toBeNull();
    expect(assignProject(moved, trader, null)[1]!.memberColors).toBeUndefined();
    expect(setGroupOpens(groups, "Trading", false)[0]).toEqual({
      name: "Trading",
      projectIds: [trader],
      opensIntoMembers: false,
    });
    expect(setGroupOpens(setGroupOpens(groups, "Trading", false), "Trading", true)).toEqual(groups);
  });

  it("lists the members to show instead, keeping the same rows when it switches", () => {
    const both = assignProject(groups, app, "Trading");
    const hidden = setMemberShown(both, trader, false);
    // Switching to a show list keeps who shows: app stays shown, trader stays hidden.
    const only = setGroupShowsOnly(hidden, "Trading", true);
    expect(only[0]).toEqual({ name: "Trading", projectIds: [trader, app], shownMembers: [app] });
    expect([memberShown(only, app), memberShown(only, trader)]).toEqual([true, false]);
    // A member joining a show-list group starts hidden; Shown edits the show list.
    const joined = assignFolder(only, "/work/main", "Trading");
    expect(memberShown(joined, folderMemberKey("/work/main"))).toBe(false);
    expect(setMemberShown(only, app, false)[0]?.shownMembers).toEqual([]);
    // Switching back lists the hidden members again.
    expect(setGroupShowsOnly(only, "Trading", false)[0]).toEqual({
      name: "Trading",
      projectIds: [trader, app],
      hiddenMembers: [trader],
    });
  });

  it("refuses blank and duplicate names, ignoring case, but lets a group keep its own", () => {
    expect(usableGroupName(groups, "  Projects ", null)).toBe("Projects");
    expect(usableGroupName(groups, "trading", null)).toBeNull();
    expect(usableGroupName(groups, "trading", "Trading")).toBe("trading");
    expect(usableGroupName(groups, "   ", null)).toBeNull();
    expect(newGroupName([...groups, { name: "Group 3", projectIds: [] }], "Group")).toBe("Group 4");
  });

  it("keeps a folder in one group, keeps folders and sharing when projects move, and removes with null", () => {
    const withFolder = setGroupShared(
      assignFolder(groups, "/work/main", "Tooling"),
      "Tooling",
      true,
    );
    expect(withFolder[1]).toEqual({
      name: "Tooling",
      projectIds: [],
      folders: ["/work/main"],
      shared: true,
    });
    const moved = assignProject(assignFolder(withFolder, "/work/main", "Trading"), app, "Tooling");
    expect(folderEntries(moved)).toEqual([{ folder: "/work/main", group: "Trading" }]);
    expect(moved[1]).toEqual({ name: "Tooling", projectIds: [app], shared: true });
    expect(assignFolder(moved, "/work/main", null)).toEqual([
      { name: "Trading", projectIds: [trader] },
      { name: "Tooling", projectIds: [app], shared: true },
    ]);
    expect(setGroupShared(moved, "Tooling", false)[1]).toEqual({
      name: "Tooling",
      projectIds: [app],
    });
  });

  it("takes absolute and home folders, without a trailing slash", () => {
    expect(usableFolder(" /work/main/ ")).toBe("/work/main");
    expect(usableFolder("~/notes")).toBe("~/notes");
    expect(usableFolder("/")).toBe("/");
    expect(usableFolder("work/main")).toBeNull();
  });

  it("sends a removed group's projects to Other", () => {
    expect(groupOfProject(removeGroup(groups, "Trading"), trader)).toBeNull();
  });

  it("keeps the groups last sent until the server's settings hold them", () => {
    const first = setGroupShared(groups, "Tooling", true);
    const second = assignProject(first, app, "Tooling");
    // The first save's echo arrives while the second is still on its way.
    expect(unsavedWorkGroups(first, second)).toBe(second);
    // The second's echo, its keys in the server's order, ends the local copy.
    const echoed = second.map(({ shared, projectIds, name }) => ({
      projectIds,
      name,
      ...(shared === undefined ? {} : { shared }),
    }));
    expect(unsavedWorkGroups(echoed, second)).toBeNull();
    expect(unsavedWorkGroups(groups, null)).toBeNull();
  });
});
