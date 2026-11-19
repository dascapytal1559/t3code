import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignProject,
  groupOfProject,
  newGroupName,
  removeGroup,
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

  it("sends a removed group's projects to Other", () => {
    expect(groupOfProject(removeGroup(groups, "Trading"), trader)).toBeNull();
  });
});
