import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/** Matches PROJECT_SEARCH_ENTRIES_MAX_LIMIT, the schema cap on searchEntries. */
const SEARCH_ENRICH_LIMIT = 200;
const SEARCH_ENRICH_DEBOUNCE_MS = 200;

const EMPTY_EVENTS_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("lazy-project-entries-events:empty"),
);

interface LazyEntriesStore {
  generation: number;
  rootLoaded: boolean;
  readonly loadedDirs: Set<string>;
  readonly pendingDirs: Map<string, Promise<boolean>>;
  readonly entriesByDir: Map<string, ReadonlyArray<ProjectEntry>>;
  readonly entryKinds: Map<string, ProjectEntry["kind"]>;
}

function createStore(generation: number): LazyEntriesStore {
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

export interface LazyProjectEntries {
  /** Flat merged listing of every loaded directory plus server search matches. */
  readonly entries: ReadonlyArray<ProjectEntry>;
  /** Directories whose direct children are loaded; drives the row child counts. */
  readonly loadedDirPaths: ReadonlySet<string>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  /** Fetches one directory's children when its row is expanded. */
  readonly ensureDirLoaded: (dirPath: string) => void;
  /** Loads every ancestor directory of a file path so a reveal can show it. */
  readonly ensurePathLoaded: (relativePath: string) => void;
}

/**
 * VS Code-style lazy source for the mobile file tree: the flat entries array
 * grows one directory listing at a time as rows are expanded, and
 * buildFileTree synthesizes the nested view from whatever is loaded.
 */
export function useLazyProjectEntries(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly searchQuery: string;
}): LazyProjectEntries {
  const { enabled } = input;
  const environmentId = enabled ? input.environmentId : null;
  const cwd = enabled ? input.cwd : null;
  const storeRef = useRef<LazyEntriesStore | null>(null);
  const generationRef = useRef(0);
  const [version, setVersion] = useState(0);
  const [isRootPending, setIsRootPending] = useState(false);
  const [isRescanning, setIsRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rescan = useAtomCommand(projectEnvironment.refreshEntries);

  const dirAtom = useCallback(
    (dirPath: string) =>
      environmentId !== null && cwd !== null
        ? projectEnvironment.listDirectory({ environmentId, input: { cwd, path: dirPath } })
        : null,
    [cwd, environmentId],
  );

  const fetchDir = useCallback(
    async (dirPath: string) => {
      const atom = dirAtom(dirPath);
      if (atom === null) return new Error("No workspace selected.");
      const result = await executeAtomQuery(appAtomRegistry, atom, {
        reportFailure: false,
        reportDefect: false,
      });
      if (result._tag === "Success") return result.value.entries;
      const cause = Cause.squash(result.cause);
      return new Error(cause instanceof Error ? cause.message : "Workspace query failed.");
    },
    [dirAtom],
  );

  const applyDirListing = useCallback(
    (store: LazyEntriesStore, dirPath: string, entries: ReadonlyArray<ProjectEntry>) => {
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
      setVersion((current) => current + 1);
    },
    [],
  );

  const loadDir = useCallback(
    (dirPath: string): Promise<boolean> => {
      const store = storeRef.current;
      if (store === null) return Promise.resolve(false);
      if (store.loadedDirs.has(dirPath)) return Promise.resolve(true);
      const pending = store.pendingDirs.get(dirPath);
      if (pending) return pending;
      const generation = store.generation;
      const request = fetchDir(dirPath).then((entries) => {
        if (storeRef.current !== store || store.generation !== generation) return false;
        store.pendingDirs.delete(dirPath);
        if (entries instanceof Error) return false;
        if (dirPath !== "" && store.entryKinds.get(dirPath) !== "directory") return false;
        applyDirListing(store, dirPath, entries);
        return true;
      });
      store.pendingDirs.set(dirPath, request);
      return request;
    },
    [applyDirListing, fetchDir],
  );

  const refreshLoadedDirs = useCallback(async () => {
    const store = storeRef.current;
    if (store === null || !store.rootLoaded) return;
    const generation = store.generation;
    const loaded = [...store.loadedDirs];
    for (const dirPath of loaded) {
      const atom = dirAtom(dirPath);
      if (atom !== null) appAtomRegistry.refresh(atom);
    }
    await Promise.all(
      loaded.map(async (dirPath) => {
        const entries = await fetchDir(dirPath);
        if (storeRef.current !== store || store.generation !== generation) return;
        // A vanished directory fails its own listing; the parent's diff
        // drops its subtree from the merged entries.
        if (entries instanceof Error) return;
        if (dirPath !== "" && store.entryKinds.get(dirPath) !== "directory") return;
        if (!store.loadedDirs.has(dirPath)) return;
        applyDirListing(store, dirPath, entries);
      }),
    );
  }, [applyDirListing, dirAtom, fetchDir]);

  useEffect(() => {
    if (environmentId === null || cwd === null) {
      storeRef.current = null;
      return;
    }
    generationRef.current += 1;
    const store = createStore(generationRef.current);
    storeRef.current = store;
    setError(null);
    setIsRootPending(true);
    setVersion((current) => current + 1);
    void fetchDir("").then((entries) => {
      if (storeRef.current !== store) return;
      setIsRootPending(false);
      if (entries instanceof Error) {
        setError(entries.message);
        return;
      }
      store.rootLoaded = true;
      // The tree opens collapsed (VS Code default); expanding a row fetches
      // its listing through ensureDirLoaded.
      applyDirListing(store, "", entries);
    });
    return () => {
      store.generation = -1;
      if (storeRef.current === store) storeRef.current = null;
    };
  }, [applyDirListing, cwd, environmentId, fetchDir, loadDir]);

  // One watcher event per change burst; refetch every loaded directory and
  // diff so the merged entries converge on the filesystem.
  const eventsAtom =
    environmentId !== null && cwd !== null
      ? projectEnvironment.entriesEvents({ environmentId, input: { cwd } })
      : EMPTY_EVENTS_ATOM;
  const events = useAtomValue(eventsAtom);
  const lastEventsRef = useRef<unknown>(null);
  useEffect(() => {
    if (environmentId === null || cwd === null) return;
    if (lastEventsRef.current === null) {
      lastEventsRef.current = events;
      return;
    }
    if (lastEventsRef.current === events) return;
    lastEventsRef.current = events;
    void refreshLoadedDirs();
  }, [cwd, environmentId, events, refreshLoadedDirs]);

  const refresh = useCallback(() => {
    if (environmentId === null || cwd === null) return;
    setIsRescanning(true);
    void rescan({ environmentId, input: { cwd } }).then(async () => {
      await refreshLoadedDirs();
      setIsRescanning(false);
    });
  }, [cwd, environmentId, refreshLoadedDirs, rescan]);

  const ensureDirLoaded = useCallback(
    (dirPath: string) => {
      void loadDir(dirPath);
    },
    [loadDir],
  );

  const ensurePathLoaded = useCallback(
    (relativePath: string) => {
      void (async () => {
        const store = storeRef.current;
        if (store === null) return;
        if (!(await loadDir(""))) return;
        const segments = relativePath.split("/").filter(Boolean);
        let dirPath = "";
        for (const segment of segments.slice(0, -1)) {
          dirPath = dirPath ? `${dirPath}/${segment}` : segment;
          if (store.entryKinds.get(dirPath) !== "directory") return;
          if (!(await loadDir(dirPath))) return;
        }
      })();
    },
    [loadDir],
  );

  // The in-tree search only sees loaded entries, so merge bounded server
  // matches in; buildFileTree synthesizes their ancestor directories.
  const debouncedSearchQuery = useDebouncedValue(
    input.searchQuery.trim(),
    SEARCH_ENRICH_DEBOUNCE_MS,
  );
  const searchResult = useEnvironmentQuery(
    environmentId !== null && cwd !== null && debouncedSearchQuery.length > 0
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd, query: debouncedSearchQuery, limit: SEARCH_ENRICH_LIMIT },
        })
      : null,
  );
  const searchEntries = searchResult.data?.entries;

  const entries = useMemo(() => {
    const store = storeRef.current;
    if (store === null) return [];
    const merged: ProjectEntry[] = [];
    const seen = new Set<string>();
    for (const dirEntries of store.entriesByDir.values()) {
      for (const entry of dirEntries) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        merged.push(entry);
      }
    }
    for (const entry of searchEntries ?? []) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      merged.push(entry);
    }
    return merged;
    // version invalidates this memo whenever a directory listing lands.
  }, [searchEntries, version]);

  const loadedDirPaths = useMemo(() => {
    const store = storeRef.current;
    return store === null ? new Set<string>() : new Set(store.loadedDirs);
  }, [version]);

  return {
    entries,
    loadedDirPaths,
    error,
    isPending: isRootPending || isRescanning,
    refresh,
    ensureDirLoaded,
    ensurePathLoaded,
  };
}
