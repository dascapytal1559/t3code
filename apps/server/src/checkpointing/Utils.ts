import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";
import { threadVcsCwd } from "@t3tools/shared/projectVcs";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}

/**
 * Where git runs for a thread: its worktree, else the project's VCS root, else
 * the workspace root. Checkpoints are git refs, so they live here rather than
 * at the agent cwd from `resolveThreadWorkspaceCwd`.
 */
export function resolveThreadVcsCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly vcsRoot?: string | null | undefined;
  }>;
}): string | undefined {
  const project = input.projects.find((project) => project.id === input.thread.projectId);
  if (!project) {
    return input.thread.worktreePath ?? undefined;
  }
  return threadVcsCwd({ project, worktreePath: input.thread.worktreePath });
}
