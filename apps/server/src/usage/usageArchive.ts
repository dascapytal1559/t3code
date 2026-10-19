// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork feature: usage from machines and accounts that no longer run T3, read
 * from copies kept under an archive root. Each folder directly under a root is
 * one host; the copies inside keep the layout of the machine they came from.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@t3tools/contracts";

import { LEGACY_SCAN_CACHE_FILE_NAMES, SCAN_CACHE_FILE_NAME } from "./usageScanCache.ts";

export interface UsageArchiveLabel {
  /** The folder name under the archive root. */
  readonly host: string;
  /** Where the copy sits inside the host folder, such as `.claude`, or `.` for the folder itself. */
  readonly instance: string;
}

export interface ArchivedTranscriptDir extends UsageArchiveLabel {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly fileName?: string;
}

/** A T3 server's saved usage, which still holds usage whose transcripts were deleted. */
export interface ArchivedScanCache extends UsageArchiveLabel {
  readonly file: string;
}

export interface UsageArchive {
  readonly transcripts: readonly ArchivedTranscriptDir[];
  readonly caches: readonly ArchivedScanCache[];
}

const MAX_DEPTH = 6;
// Bounds a walk into an archive that also holds unrelated trees, such as worktrees.
const MAX_VISITED_DIRS = 5_000;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const CODEX_SESSION_CHILD = /^(?:\d{4}|rollout-.*\.jsonl)$/;
// Newest first: a folder can hold one file per cache version, and the newest has the most usage.
const SCAN_CACHE_FILE_NAMES = [SCAN_CACHE_FILE_NAME, ...LEGACY_SCAN_CACHE_FILE_NAMES];

async function readDir(dir: string) {
  try {
    return await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Claude keeps `projects/<project>/<session>.jsonl`. */
async function isClaudeProjects(dir: string): Promise<boolean> {
  for (const entry of await readDir(dir)) {
    if (!entry.isDirectory()) continue;
    const files = await readDir(NodePath.join(dir, entry.name));
    if (files.some((file) => file.isFile() && file.name.endsWith(".jsonl"))) return true;
  }
  return false;
}

/** Codex keeps `sessions/<year>/<month>/<day>/rollout-*.jsonl`. */
async function isCodexSessions(dir: string): Promise<boolean> {
  return (await readDir(dir)).some((entry) => CODEX_SESSION_CHILD.test(entry.name));
}

async function scanHost(
  hostDir: string,
  host: string,
  transcripts: ArchivedTranscriptDir[],
  caches: ArchivedScanCache[],
): Promise<void> {
  const instanceOf = (dir: string) => NodePath.relative(hostDir, dir) || ".";
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited >= MAX_VISITED_DIRS) return;
    visited += 1;
    const entries = await readDir(dir);
    const names = new Set(entries.map((entry) => entry.name));
    const cacheName = SCAN_CACHE_FILE_NAMES.find((name) => names.has(name));
    if (cacheName !== undefined) {
      caches.push({ host, instance: instanceOf(dir), file: NodePath.join(dir, cacheName) });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      const child = NodePath.join(dir, entry.name);
      if (entry.name === "projects" && (await isClaudeProjects(child))) {
        transcripts.push({ host, instance: instanceOf(dir), provider: "claude", dir: child });
      } else if (entry.name === "sessions" && NodePath.basename(dir) === ".grok") {
        // As the Grok reader does: only `updates.jsonl` carries usage.
        transcripts.push({
          host,
          instance: instanceOf(dir),
          provider: "grok",
          dir: child,
          fileName: "updates.jsonl",
        });
      } else if (entry.name === "sessions" && (await isCodexSessions(child))) {
        transcripts.push({ host, instance: instanceOf(dir), provider: "codex", dir: child });
      } else {
        await walk(child, depth + 1);
      }
    }
  };
  await walk(hostDir, 0);
}

/** A missing or unreadable root has nothing archived; it is not an error. */
export async function discoverUsageArchive(roots: readonly string[]): Promise<UsageArchive> {
  const transcripts: ArchivedTranscriptDir[] = [];
  const caches: ArchivedScanCache[] = [];
  for (const root of roots) {
    const hosts = (await readDir(root)).filter((entry) => entry.isDirectory());
    for (const host of hosts) {
      await scanHost(NodePath.join(root, host.name), host.name, transcripts, caches);
    }
  }
  return { transcripts, caches };
}

const upgradeRows = (rows: unknown) =>
  Array.isArray(rows)
    ? rows.map((row) => (Array.isArray(row) && row.length === 10 ? [...row, 0] : row))
    : rows;

/**
 * Version 3 caches, which retired servers may still hold, predate the speed
 * column. Their usage may be the only copy left, so read it at standard speed,
 * as version 4 Codex records already are, instead of dropping it.
 */
export function upgradeArchivedScanCache(document: unknown): unknown {
  if (typeof document !== "object" || document === null) return document;
  const root = document as { readonly version?: unknown; readonly files?: unknown };
  if (root.version !== 3 || typeof root.files !== "object" || root.files === null) {
    return document;
  }
  const files = Object.fromEntries(
    Object.entries(root.files).map(([path, file]) => [
      path,
      typeof file === "object" && file !== null
        ? {
            ...file,
            r: upgradeRows((file as { r?: unknown }).r),
            t: upgradeRows((file as { t?: unknown }).t),
          }
        : file,
    ]),
  );
  return { ...root, version: 4, files };
}
