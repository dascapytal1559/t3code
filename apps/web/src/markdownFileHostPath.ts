import { formatFilePathPosition, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { MarkdownFileLinkMeta } from "./markdown-links";

interface MarkdownFileHostPath {
  absolutePath: string;
  matched: boolean;
}

/** Reports per path whether it exists, or null when that cannot be checked. */
export type MarkdownFilePathsExist = (
  absolutePaths: readonly string[],
) => Promise<ReadonlyArray<boolean> | null>;

/** Beside the file first, then the workspace root; with neither found, both count as attempted. */
export async function pickMarkdownFileCandidate(
  meta: MarkdownFileLinkMeta,
  pathsExist: MarkdownFilePathsExist,
): Promise<{ filePath: string; alsoTried: string | null }> {
  const fallback = meta.fallbackFilePath;
  if (fallback === null) return { filePath: meta.filePath, alsoTried: null };
  const exists = await pathsExist([meta.filePath, fallback]);
  if (exists?.[0]) return { filePath: meta.filePath, alsoTried: null };
  if (exists?.[1]) return { filePath: fallback, alsoTried: null };
  return { filePath: meta.filePath, alsoTried: fallback };
}

export async function resolveMarkdownFileHostPath(input: {
  meta: MarkdownFileLinkMeta;
  cwd: string | undefined;
  findWorkspaceMatch: (workspaceRelativePath: string) => Promise<string | null>;
  pathsExist: MarkdownFilePathsExist;
}) {
  const { meta, cwd } = input;
  if (meta.fallbackFilePath !== null) {
    const { filePath } = await pickMarkdownFileCandidate(meta, input.pathsExist);
    return { absolutePath: filePath, matched: filePath !== meta.filePath };
  }
  const match =
    meta.workspaceLookupPath && cwd
      ? await input.findWorkspaceMatch(meta.workspaceLookupPath)
      : null;
  return match && cwd
    ? { absolutePath: resolvePathLinkTarget(match, cwd), matched: true }
    : { absolutePath: meta.filePath, matched: false };
}

export function markdownFileEditorTarget(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
) {
  return hostPath.matched
    ? formatFilePathPosition({ ...meta, path: hostPath.absolutePath })
    : meta.targetPath;
}

export function markdownFileCopyPaths(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
  cwd: string | undefined,
) {
  const fullPath = markdownFileEditorTarget(meta, hostPath);
  return {
    fullPath,
    relativePath: formatFilePathPosition({
      ...meta,
      path: workspaceRelativeFilePath(hostPath.absolutePath, cwd) ?? meta.filePath,
    }),
  };
}
