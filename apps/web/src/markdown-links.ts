import { isLocalEditorFileUrl } from "@t3tools/contracts";
import { fileBasename, isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import {
  inlineCodeFilePathCandidate,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  resolveMarkdownFileLink,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  /** Fork: inline code's workspace-root reading, opened when nothing sits beside the document. */
  rootFallbackPath: string | null;
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

// Every message resolves its links and code spans more than once while rendering.
const MAX_MEMOIZED = 4_000;
const inlineCodeMetas = new Map<string, MarkdownFileLinkMeta | null>();
const linkMetas = new Map<string, MarkdownFileLinkMeta | null>();

function memoized(
  cache: Map<string, MarkdownFileLinkMeta | null>,
  key: string,
  resolve: () => MarkdownFileLinkMeta | null,
): MarkdownFileLinkMeta | null {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (cache.size >= MAX_MEMOIZED) cache.clear();
  const meta = resolve();
  cache.set(key, meta);
  return meta;
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  documentDir?: string,
): MarkdownFileLinkMeta | null {
  return memoized(inlineCodeMetas, `${cwd ?? ""}\u0000${documentDir ?? ""}\u0000${codeText}`, () =>
    resolveInlineCodeFileLinkMetaUncached(codeText, cwd, documentDir),
  );
}

function resolveInlineCodeFileLinkMetaUncached(
  codeText: string,
  cwd: string | undefined,
  documentDir: string | undefined,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;
  const meta = resolveMarkdownFileLinkMeta(candidate, cwd, documentDir);
  if (meta === null) return null;
  return {
    ...meta,
    rootFallbackPath: rootFallbackPath(candidate, meta.filePath, cwd, documentDir),
  };
}

/**
 * Docs write inline-code paths from the repository's top folder, so inline code in a
 * document below the workspace root also reads from there. Links never do.
 */
function rootFallbackPath(
  candidate: string,
  filePath: string,
  cwd: string | undefined,
  documentDir: string | undefined,
): string | null {
  if (!cwd || documentDir === undefined) return null;
  const source = parseMarkdownFileLink(candidate);
  if (source === null || isAbsolutePath(source.path) || /^(?:~|\.{1,2})[\\/]/.test(source.path)) {
    return null;
  }
  const documentFolder = workspaceRelativeFilePath(documentDir, cwd);
  if (documentFolder === null || documentFolder === ".") return null;
  const fallback = resolvePathLinkTarget(source.path, cwd);
  return fallback !== filePath && workspaceRelativeFilePath(fallback, cwd) !== null
    ? fallback
    : null;
}

/** The text a file link names after `#`; a `#L12` line fragment is read as its line instead. */
function linkedHeading(href: string): string | null {
  const destination = normalizeMarkdownLinkDestination(href);
  const { hash } = parseFileUrlHref(destination) ?? splitMarkdownLinkSearchAndHash(destination);
  return hash.length <= 1 ? null : safeDecodeURIComponent(hash.slice(1));
}

/**
 * Fork: a path written in a document reads from `documentDir`, the document's own folder,
 * and only there (inline code adds `rootFallbackPath`). Without one the path is from a chat
 * message: it reads from the workspace, and a miss falls back to upstream's workspace search
 * (`workspaceLookupPath`).
 */
export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  documentDir?: string,
): MarkdownFileLinkMeta | null {
  if (href === undefined) return null;
  return memoized(linkMetas, `${cwd ?? ""}\u0000${documentDir ?? ""}\u0000${href}`, () =>
    resolveMarkdownFileLinkMetaUncached(href, cwd, documentDir),
  );
}

function resolveMarkdownFileLinkMetaUncached(
  href: string | undefined,
  cwd: string | undefined,
  documentDir: string | undefined,
): MarkdownFileLinkMeta | null {
  const resolved = resolveMarkdownFileLink(href, cwd, documentDir ?? cwd);
  if (!resolved) return null;
  const {
    sourcePath,
    targetPath,
    position: { path, ...lines },
  } = resolved;
  const heading = href ? linkedHeading(href) : null;
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...lines,
    rootFallbackPath: null,
    ...(heading !== null && lines.line === undefined ? { heading } : {}),
    workspaceLookupPath:
      !isAbsolutePath(sourcePath) && documentDir === undefined ? sourcePath : null,
  };
}
