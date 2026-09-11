/**
 * Where source control runs for a project. Threads own a worktree when they
 * have one; otherwise the project's explicit VCS root wins over the workspace
 * root so a meta workspace of symlinks can still commit from its real repo.
 * Agent cwd, file search, and project scripts keep using the workspace root.
 */
export function projectVcsRoot(project: {
  readonly workspaceRoot: string;
  readonly vcsRoot?: string | null | undefined;
}): string {
  return project.vcsRoot ?? project.workspaceRoot;
}

export function threadVcsCwd(input: {
  readonly project: {
    readonly workspaceRoot: string;
    readonly vcsRoot?: string | null | undefined;
  };
  readonly worktreePath?: string | null | undefined;
}): string {
  return input.worktreePath ?? projectVcsRoot(input.project);
}
