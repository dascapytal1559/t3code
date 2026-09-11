import { describe, expect, it } from "vite-plus/test";

import { projectVcsRoot, threadVcsCwd } from "./projectVcs.ts";

describe("projectVcs", () => {
  it("falls back to the workspace root when no VCS root is set", () => {
    expect(projectVcsRoot({ workspaceRoot: "/meta" })).toBe("/meta");
    expect(projectVcsRoot({ workspaceRoot: "/meta", vcsRoot: null })).toBe("/meta");
    expect(projectVcsRoot({ workspaceRoot: "/meta", vcsRoot: "/meta/repo" })).toBe("/meta/repo");
  });

  it("lets a thread's worktree win over the project's VCS root", () => {
    const project = { workspaceRoot: "/meta", vcsRoot: "/meta/repo" };
    expect(threadVcsCwd({ project, worktreePath: null })).toBe("/meta/repo");
    expect(threadVcsCwd({ project })).toBe("/meta/repo");
    expect(threadVcsCwd({ project, worktreePath: "/worktrees/repo/feature" })).toBe(
      "/worktrees/repo/feature",
    );
  });
});
