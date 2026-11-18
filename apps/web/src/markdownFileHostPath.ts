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

/** Beside the document first, then the workspace root; with neither found, the path beside it. */
export async function pickMarkdownFilePath(
  meta: MarkdownFileLinkMeta,
  pathsExist: MarkdownFilePathsExist,
): Promise<string> {
  const fallback = meta.rootFallbackPath;
  if (fallback === null) return meta.filePath;
  const exists = await pathsExist([meta.filePath, fallback]);
  return exists?.[0] === false && exists[1] === true ? fallback : meta.filePath;
}

export async function resolveMarkdownFileHostPath(input: {
  meta: MarkdownFileLinkMeta;
  cwd: string | undefined;
  findWorkspaceMatch: (workspaceRelativePath: string) => Promise<string | null>;
  pathsExist: MarkdownFilePathsExist;
}) {
  const { meta, cwd } = input;
  if (meta.rootFallbackPath !== null) {
    const absolutePath = await pickMarkdownFilePath(meta, input.pathsExist);
    return { absolutePath, matched: absolutePath !== meta.filePath };
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
