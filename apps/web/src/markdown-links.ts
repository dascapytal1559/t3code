import { isLocalEditorFileUrl } from "@t3tools/contracts";
import { fileBasename, isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import {
  inlineCodeFilePathCandidate,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  endLine?: number;
  /** The heading a link like `notes.md#setup` names, to scroll to once the file opens. */
  heading?: string;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

export function isLocalEditorFileHref(href: string): boolean {
  try {
    return isLocalEditorFileUrl(new URL(href));
  } catch {
    return false;
  }
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  documentDir?: string,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(candidate, cwd, documentDir);
}

/** The text a file link names after `#`; a `#L12` line fragment is read as its line instead. */
function linkedHeading(href: string): string | null {
  const destination = normalizeMarkdownLinkDestination(href);
  const { hash } = parseFileUrlHref(destination) ?? splitMarkdownLinkSearchAndHash(destination);
  return hash.length <= 1 ? null : safeDecodeURIComponent(hash.slice(1));
}

/**
 * Fork: a path written in a document reads from `documentDir`, the document's own folder,
 * and only there. Without one the path is from a chat message: it reads from the workspace,
 * and a miss falls back to upstream's workspace search (`workspaceLookupPath`).
 */
export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  documentDir?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, documentDir ?? cwd);
  if (!targetPath) return null;
  const source = href ? parseMarkdownFileLink(href) : null;
  const heading = href ? linkedHeading(href) : null;
  return {
    ...buildFileLinkMetaFromTarget(targetPath, cwd),
    ...(source?.endLine !== undefined ? { endLine: source.endLine } : {}),
    ...(heading !== null && source?.line === undefined ? { heading } : {}),
    workspaceLookupPath:
      source !== null && !isAbsolutePath(source.path) && documentDir === undefined
        ? source.path
        : null,
  };
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string) {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
