import type { FileTree, FileTreeBatchOperation } from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";

/** Matches PROJECT_SEARCH_ENTRIES_MAX_LIMIT, the schema cap on searchEntries. */
const SEARCH_ENRICH_LIMIT = 200;

const EMPTY_EVENTS_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("lazy-file-tree-events:empty"),
);

function treePath(entry: Pick<ProjectEntry, "path" | "kind">): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export interface LazyTreeStore {
  generation: number;
  rootLoaded: boolean;
  /** Directories whose direct children are applied to the model. Key "" is the root. */
  readonly loadedDirs: Set<string>;
  readonly pendingDirs: Map<string, Promise<boolean>>;
  readonly entriesByDir: Map<string, ReadonlyArray<ProjectEntry>>;
  /** Directories present in the tree whose children have not been requested yet. */
  readonly unloadedDirs: Set<string>;
  readonly entryKinds: Map<string, ProjectEntry["kind"]>;
  readonly symlinkTreePaths: Set<string>;
  readonly ignoredTreePaths: Set<string>;
}

export function createStore(generation: number): LazyTreeStore {
  return {
    generation,
    rootLoaded: false,
    loadedDirs: new Set(),
    pendingDirs: new Map(),
    entriesByDir: new Map(),
    unloadedDirs: new Set(),
    entryKinds: new Map(),
    symlinkTreePaths: new Set(),
    ignoredTreePaths: new Set(),
  };
}

function purgeSubtree(store: LazyTreeStore, rootPath: string): void {
  const prefix = `${rootPath}/`;
  for (const path of store.entryKinds.keys()) {
    if (path !== rootPath && !path.startsWith(prefix)) continue;
    store.entryKinds.delete(path);
    store.symlinkTreePaths.delete(path);
    store.symlinkTreePaths.delete(`${path}/`);
    store.ignoredTreePaths.delete(path);
    store.ignoredTreePaths.delete(`${path}/`);
    store.loadedDirs.delete(path);
    store.unloadedDirs.delete(path);
    store.entriesByDir.delete(path);
  }
}

export function trackEntry(store: LazyTreeStore, entry: ProjectEntry): void {
  store.entryKinds.set(entry.path, entry.kind);
  if (entry.symlink) {
    store.symlinkTreePaths.add(treePath(entry));
  } else {
    store.symlinkTreePaths.delete(treePath(entry));
  }
  if (entry.ignored) {
    store.ignoredTreePaths.add(treePath(entry));
  } else {
    store.ignoredTreePaths.delete(treePath(entry));
  }
  if (
    entry.kind === "directory" &&
    !store.loadedDirs.has(entry.path) &&
    !store.pendingDirs.has(entry.path)
  ) {
    store.unloadedDirs.add(entry.path);
  }
}

/**
 * Diffs a fresh directory listing against what the model already shows and
 * applies the difference as granular mutations, so expansion and selection
 * state survive watcher-driven refreshes.
 */
export function applyDirListing(
  store: LazyTreeStore,
  model: Pick<FileTree, "batch" | "setGitStatus">,
  dirPath: string,
  entries: ReadonlyArray<ProjectEntry>,
): void {
  const ops: FileTreeBatchOperation[] = [];
  const nextByPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  for (const previous of store.entriesByDir.get(dirPath) ?? []) {
    const next = nextByPath.get(previous.path);
    if (next && next.kind === previous.kind) continue;
    ops.push({ type: "remove", path: treePath(previous), recursive: true });
    purgeSubtree(store, previous.path);
  }
  for (const entry of entries) {
    const knownKind = store.entryKinds.get(entry.path);
    if (knownKind !== entry.kind) {
      // Entries can be known before their parent loads (search enrichment),
      // so a kind flip needs the old row removed before the new one lands.
      if (knownKind !== undefined) {
        ops.push({
          type: "remove",
          path: treePath({ path: entry.path, kind: knownKind }),
          recursive: true,
        });
        purgeSubtree(store, entry.path);
      }
      ops.push({ type: "add", path: treePath(entry) });
    }
    trackEntry(store, entry);
  }
  store.entriesByDir.set(dirPath, entries);
  store.loadedDirs.add(dirPath);
  store.unloadedDirs.delete(dirPath);
  if (ops.length > 0) model.batch(ops);
  model.setGitStatus(
    [...store.ignoredTreePaths].map((path) => ({ path, status: "ignored" as const })),
  );
}

export interface LazyFileTree {
  readonly isPending: boolean;
  readonly error: string | null;
  /**
   * The workspace root's direct child directories in treePath form. The
   * expand/collapse-all toggle works on this one level: the rest of the tree
   * is only known lazily, and expanding these fetches exactly one listing each.
   */
  readonly rootDirectoryPaths: ReadonlyArray<string>;
  readonly refresh: () => void;
  /**
   * Loads every ancestor directory of a workspace-relative file path.
   * Resolves true once the file's row exists in the tree.
   */
  readonly ensurePathLoaded: (relativePath: string) => Promise<boolean>;
}

/**
 * VS Code-style lazy loader for the file browser: the model starts from the
 * workspace root's direct children and every directory fetches its own
 * listing the first time it is expanded, so workspaces of any size stay
 * cheap to open. Tree search stays useful beyond loaded directories by
 * merging bounded server search matches into the model.
 */
export function useLazyFileTree(options: {
  readonly model: FileTree;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly searchValue: string;
  readonly entryKindsRef: { current: ReadonlyMap<string, ProjectEntry["kind"]> };
  readonly symlinkTreePathsRef: { current: ReadonlySet<string> };
}): LazyFileTree {
  const { model, environmentId, cwd, enabled, entryKindsRef, symlinkTreePathsRef } = options;
  const storeRef = useRef<LazyTreeStore | null>(null);
  const generationRef = useRef(0);
  const [isRootPending, setIsRootPending] = useState(enabled);
  const [isRescanning, setIsRescanning] = useState(false);
  const [rootEntries, setRootEntries] = useState<ReadonlyArray<ProjectEntry>>([]);
  const [error, setError] = useState<string | null>(null);
  const rescan = useAtomCommand(projectEnvironment.refreshEntries);

  const dirAtom = useCallback(
    (dirPath: string) =>
      projectEnvironment.listDirectory({ environmentId, input: { cwd, path: dirPath } }),
    [cwd, environmentId],
  );

  const fetchDir = useCallback(
    async (dirPath: string) => {
      const result = await executeAtomQuery(appAtomRegistry, dirAtom(dirPath), {
        reportFailure: false,
        reportDefect: false,
      });
      if (result._tag === "Success") return result.value.entries;
      const cause = Cause.squash(result.cause);
      return new Error(cause instanceof Error ? cause.message : "Workspace query failed.");
    },
    [dirAtom],
  );

  const scanExpandedDirsRef = useRef<() => void>(() => {});

  const loadDir = useCallback(
    (dirPath: string): Promise<boolean> => {
      const store = storeRef.current;
      if (store === null) return Promise.resolve(false);
      if (store.loadedDirs.has(dirPath)) return Promise.resolve(true);
      const pending = store.pendingDirs.get(dirPath);
      if (pending) return pending;
      store.unloadedDirs.delete(dirPath);
      const generation = store.generation;
      const request = fetchDir(dirPath).then((entries) => {
        if (storeRef.current !== store || store.generation !== generation) return false;
        store.pendingDirs.delete(dirPath);
        // A failed listing stays out of unloadedDirs so an expanded broken
        // directory does not retry in a loop; manual refresh re-arms it.
        if (entries instanceof Error) return false;
        if (dirPath !== "" && store.entryKinds.get(dirPath) !== "directory") return false;
        applyDirListing(store, model, dirPath, entries);
        if (dirPath === "") setRootEntries(entries);
        scanExpandedDirsRef.current();
        return true;
      });
      store.pendingDirs.set(dirPath, request);
      return request;
    },
    [fetchDir, model],
  );

  const scanExpandedDirs = useCallback(() => {
    const store = storeRef.current;
    if (store === null) return;
    for (const dirPath of store.unloadedDirs) {
      const item = model.getItem(`${dirPath}/`) ?? model.getItem(dirPath);
      if (item !== null && "isExpanded" in item && item.isExpanded()) {
        void loadDir(dirPath);
      }
    }
  }, [loadDir, model]);
  useEffect(() => {
    scanExpandedDirsRef.current = scanExpandedDirs;
  }, [scanExpandedDirs]);

  const refreshLoadedDirs = useCallback(async () => {
    const store = storeRef.current;
    if (store === null || !store.rootLoaded) return;
    const generation = store.generation;
    const loaded = [...store.loadedDirs];
    for (const dirPath of loaded) {
      appAtomRegistry.refresh(dirAtom(dirPath));
    }
    await Promise.all(
      loaded.map(async (dirPath) => {
        const entries = await fetchDir(dirPath);
        if (storeRef.current !== store || store.generation !== generation) return;
        // A directory that disappeared fails its own listing; the parent's
        // diff removes its subtree, so the failure needs no handling here.
        if (entries instanceof Error) return;
        if (dirPath !== "" && store.entryKinds.get(dirPath) !== "directory") return;
        if (!store.loadedDirs.has(dirPath)) return;
        applyDirListing(store, model, dirPath, entries);
        if (dirPath === "") setRootEntries(entries);
      }),
    );
    scanExpandedDirsRef.current();
  }, [dirAtom, fetchDir, model]);

  useEffect(() => {
    if (!enabled) return;
    generationRef.current += 1;
    const store = createStore(generationRef.current);
    storeRef.current = store;
    entryKindsRef.current = store.entryKinds;
    symlinkTreePathsRef.current = store.symlinkTreePaths;
    setError(null);
    setIsRootPending(true);
    setRootEntries([]);
    model.resetPaths([]);
    void fetchDir("").then((entries) => {
      if (storeRef.current !== store) return;
      setIsRootPending(false);
      if (entries instanceof Error) {
        setError(entries.message);
        return;
      }
      store.rootLoaded = true;
      applyDirListing(store, model, "", entries);
      setRootEntries(entries);
      model.resetPaths(entries.map(treePath));
      // The tree opens collapsed (VS Code default), so this scan only loads
      // directories a reveal already expanded during the root fetch.
      scanExpandedDirsRef.current();
    });
    const unsubscribe = model.subscribe(() => scanExpandedDirsRef.current());
    return () => {
      unsubscribe();
      store.generation = -1;
      if (storeRef.current === store) storeRef.current = null;
    };
    // fetchDir carries the cwd/environment identity for this effect.
  }, [enabled, fetchDir, model]);

  // The watcher pushes one event per change burst; refetch every loaded
  // directory and diff so the visible tree converges on the filesystem.
  const eventsAtom = enabled
    ? projectEnvironment.entriesEvents({ environmentId, input: { cwd } })
    : EMPTY_EVENTS_ATOM;
  const events = useAtomValue(eventsAtom);
  const lastEventsRef = useRef<unknown>(null);
  useEffect(() => {
    if (!enabled) return;
    if (lastEventsRef.current === null) {
      lastEventsRef.current = events;
      return;
    }
    if (lastEventsRef.current === events) return;
    lastEventsRef.current = events;
    void refreshLoadedDirs();
  }, [enabled, events, refreshLoadedDirs]);

  const refresh = useCallback(() => {
    setIsRescanning(true);
    void rescan({ environmentId, input: { cwd } }).then(async () => {
      const store = storeRef.current;
      if (store !== null) {
        // Re-arm directories whose one-shot load failed so refresh retries them.
        for (const [path, kind] of store.entryKinds) {
          if (kind !== "directory") continue;
          if (store.loadedDirs.has(path) || store.pendingDirs.has(path)) continue;
          store.unloadedDirs.add(path);
        }
      }
      await refreshLoadedDirs();
      setIsRescanning(false);
    });
  }, [cwd, environmentId, refreshLoadedDirs, rescan]);

  const ensurePathLoaded = useCallback(
    async (relativePath: string) => {
      const store = storeRef.current;
      if (store === null) return false;
      if (!(await loadDir(""))) return false;
      const segments = relativePath.split("/").filter(Boolean);
      let dirPath = "";
      for (const segment of segments.slice(0, -1)) {
        dirPath = dirPath ? `${dirPath}/${segment}` : segment;
        if (store.entryKinds.get(dirPath) !== "directory") return false;
        if (!(await loadDir(dirPath))) return false;
      }
      return store.entryKinds.get(relativePath) === "file";
    },
    [loadDir],
  );

  // Tree search only sees loaded rows, so feed it bounded server matches:
  // matched paths (and their ancestor directories) join the model without
  // marking those directories loaded — expanding them still fetches fully.
  const pathSearch = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query: enabled && options.searchValue.trim().length > 0 ? options.searchValue : null,
    },
    SEARCH_ENRICH_LIMIT,
  );
  useEffect(() => {
    const store = storeRef.current;
    if (!enabled || store === null || !store.rootLoaded || pathSearch.isPending) return;
    const ops: FileTreeBatchOperation[] = [];
    for (const entry of pathSearch.entries) {
      const segments = entry.path.split("/").filter(Boolean);
      let ancestorPath = "";
      let ancestorsKnown = true;
      for (const segment of segments.slice(0, -1)) {
        ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
        const kind = store.entryKinds.get(ancestorPath);
        if (kind === "file") {
          ancestorsKnown = false;
          break;
        }
        if (kind === undefined) {
          ops.push({ type: "add", path: `${ancestorPath}/` });
          trackEntry(store, { path: ancestorPath, kind: "directory" });
        }
      }
      if (!ancestorsKnown) continue;
      if (!store.entryKinds.has(entry.path)) {
        ops.push({ type: "add", path: treePath(entry) });
        trackEntry(store, entry);
      }
    }
    if (ops.length > 0) model.batch(ops);
  }, [enabled, model, pathSearch.entries, pathSearch.isPending]);

  const rootDirectoryPaths = useMemo(
    () => rootEntries.filter((entry) => entry.kind === "directory").map(treePath),
    [rootEntries],
  );

  const isPending = isRootPending || isRescanning;
  return useMemo(
    () => ({ isPending, error, rootDirectoryPaths, refresh, ensurePathLoaded }),
    [ensurePathLoaded, error, isPending, refresh, rootDirectoryPaths],
  );
}
