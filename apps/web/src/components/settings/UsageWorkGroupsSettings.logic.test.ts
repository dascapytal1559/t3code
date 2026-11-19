import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignFolder,
  assignProject,
  folderEntries,
  groupOfProject,
  newGroupName,
  removeGroup,
  setGroupShared,
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
});
