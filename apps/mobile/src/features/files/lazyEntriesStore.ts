import type { ProjectEntry } from "@t3tools/contracts";

/**
 * Fork: per-directory listing store behind useLazyProjectEntries
 * (FORK_FEATURES.md, "Lazy per-directory file explorer"). Pure so the diffing
 * rules can be tested without the React Native runtime.
 */
export interface LazyEntriesStore {
  generation: number;
  rootLoaded: boolean;
  readonly loadedDirs: Set<string>;
  readonly pendingDirs: Map<string, Promise<boolean>>;
  readonly entriesByDir: Map<string, ReadonlyArray<ProjectEntry>>;
  readonly entryKinds: Map<string, ProjectEntry["kind"]>;
}

export function createStore(generation: number): LazyEntriesStore {
  return {
    generation,
    rootLoaded: false,
    loadedDirs: new Set(),
    pendingDirs: new Map(),
    entriesByDir: new Map(),
    entryKinds: new Map(),
  };
}

function purgeSubtree(store: LazyEntriesStore, rootPath: string): void {
  const prefix = `${rootPath}/`;
  for (const path of store.entryKinds.keys()) {
    if (path !== rootPath && !path.startsWith(prefix)) continue;
    store.entryKinds.delete(path);
    store.loadedDirs.delete(path);
    store.entriesByDir.delete(path);
  }
}

/**
 * Records one directory's fresh listing. Entries that vanished or changed kind
 * since the previous listing drop their loaded subtree, so a refresh converges
 * the merged entries on the filesystem.
 */
export function applyDirListing(
  store: LazyEntriesStore,
  dirPath: string,
  entries: ReadonlyArray<ProjectEntry>,
): void {
  const nextByPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  for (const previous of store.entriesByDir.get(dirPath) ?? []) {
    if (nextByPath.get(previous.path)?.kind === previous.kind) continue;
    purgeSubtree(store, previous.path);
  }
  for (const entry of entries) {
    store.entryKinds.set(entry.path, entry.kind);
  }
  store.entriesByDir.set(dirPath, entries);
  store.loadedDirs.add(dirPath);
}

/** Flat, de-duplicated merge of every loaded listing plus server search matches. */
export function mergeLoadedEntries(
  store: LazyEntriesStore,
  searchEntries: ReadonlyArray<ProjectEntry> | undefined,
): ProjectEntry[] {
  const merged: ProjectEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: ProjectEntry) => {
    if (seen.has(entry.path)) return;
    seen.add(entry.path);
    merged.push(entry);
  };
  for (const dirEntries of store.entriesByDir.values()) {
    for (const entry of dirEntries) push(entry);
  }
  for (const entry of searchEntries ?? []) push(entry);
  return merged;
}
