import { useMemo } from "react";
import { threadVcsCwd } from "@t3tools/shared/projectVcs";

import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
      }),
    [selectedThread?.worktreePath, selectedThreadDetail?.worktreePath],
  );

  return {
    selectedThreadWorktreePath,
    // Where the agent and file browser work.
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    // Where git runs: the worktree, else the project's VCS root, else its workspace root.
    selectedThreadVcsCwd: selectedThreadProject
      ? threadVcsCwd({ project: selectedThreadProject, worktreePath: selectedThreadWorktreePath })
      : selectedThreadWorktreePath,
  };
}
