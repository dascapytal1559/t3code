import type { VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  OrchestrationThread,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProviderInstanceId,
  ThreadId,
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { orchestrationEnvironment } from "./orchestration";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useEnvironmentThread } from "./threads";
import { vcsEnvironment } from "./vcs";
import {
  buildCheckpointDiffTargets,
  normalizeComposerPathSearchQuery,
  type CheckpointDiffTarget,
} from "./queryTargets";

const COMPOSER_PATH_SEARCH_DEBOUNCE_MS = 200;
const COMPOSER_PATH_SEARCH_LIMIT = 20;
const THREAD_SEARCH_DEBOUNCE_MS = 200;
const VCS_REF_LIST_LIMIT = 100;
const EMPTY_REFS: ReadonlyArray<VcsRef> = [];
const INITIAL_BRANCH_CURSORS = [undefined] as const;
const EMPTY_THREAD_SEARCH_MATCHES: ReadonlyArray<EnvironmentThreadSearchMatch> = Object.freeze([]);
const EMPTY_THREAD_SEARCH_ATOM = Atom.make({
  matches: EMPTY_THREAD_SEARCH_MATCHES,
  isLoading: false,
}).pipe(Atom.withLabel("mobile:thread-search:empty"));
const EMPTY_PROJECT_PATH_SEARCH_SYNC_ATOM = Atom.make(undefined).pipe(
  Atom.withLabel("mobile:project-path-search-sync:empty"),
);

interface ProjectPathSearchSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
  readonly kind?: ProjectEntryKind;
  readonly imageOnly?: boolean;
}

const projectPathSearchSyncAtom = Atom.family((key: string) => {
  const target = JSON.parse(key) as ProjectPathSearchSyncTarget;
  const searchAtom = projectEnvironment.searchEntries({
    environmentId: target.environmentId,
    input: {
      cwd: target.cwd,
      query: target.query,
      limit: target.limit,
      ...(target.kind ? { kind: target.kind } : {}),
      ...(target.imageOnly ? { imageOnly: true } : {}),
    },
  });
  const eventsAtom = projectEnvironment.entriesEvents({
    environmentId: target.environmentId,
    input: { cwd: target.cwd },
  });
  return Atom.make((get) => {
    get.subscribe(eventsAtom, () => {
      appAtomRegistry.refresh(searchAtom);
    });
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile:project-path-search-sync:${key}`));
});

const projectEntriesSyncAtom = Atom.family((key: string) => {
  const [environmentId, cwd] = JSON.parse(key) as [EnvironmentId, string];
  const listAtom = projectEnvironment.listEntries({ environmentId, input: { cwd } });
  const eventsAtom = projectEnvironment.entriesEvents({ environmentId, input: { cwd } });
  return Atom.make((get) => {
    get.subscribe(eventsAtom, () => {
      appAtomRegistry.refresh(listAtom);
    });
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile:project-entries-sync:${key}`));
});

const threadSearchResultsAtom = createThreadSearchResultsAtomFamily({
  getSearchAtom: (environmentId, query) =>
    orchestrationEnvironment.threadSearch({
      environmentId,
      input: { query },
    }),
  labelPrefix: "mobile:thread-search",
});

export interface ThreadDetailView {
  readonly data: OrchestrationThread | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isDeleted: boolean;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string | null;
}

export function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

export function useThreadSearch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isPending: boolean;
} {
  const normalizedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, THREAD_SEARCH_DEBOUNCE_MS);
  const canSearch = environmentIds.length > 0 && normalizedQuery.length >= 2;
  const settledQuery = canSearch && normalizedQuery === debouncedQuery ? debouncedQuery : null;
  const searchKey = useMemo(
    () => (settledQuery === null ? null : makeThreadSearchKey(environmentIds, settledQuery)),
    [environmentIds, settledQuery],
  );
  const result = useAtomValue(
    searchKey === null ? EMPTY_THREAD_SEARCH_ATOM : threadSearchResultsAtom(searchKey),
  );
  const isDebouncing = canSearch && normalizedQuery !== debouncedQuery;
  return {
    matches: isDebouncing ? EMPTY_THREAD_SEARCH_MATCHES : result.matches,
    isPending: canSearch && (isDebouncing || result.isLoading),
  };
}

export function useThreadDetail(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadDetailView {
  const state = useEnvironmentThread(environmentId, threadId);
  return {
    data: Option.getOrNull(state.data),
    error: Option.getOrNull(state.error),
    isPending: state.status === "synchronizing",
    isDeleted: state.status === "deleted",
  };
}

export function useBranches(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}) {
  const query = input.query?.trim() ?? "";
  return useEnvironmentQuery(
    input.environmentId !== null && input.cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            ...(query.length > 0 ? { query } : {}),
            limit: VCS_REF_LIST_LIMIT,
          },
        })
      : null,
  );
}

export function usePaginatedBranches(target: VcsRefTarget) {
  const query = target.query?.trim() ?? "";
  const targetKey =
    target.environmentId !== null && target.cwd !== null
      ? JSON.stringify([target.environmentId, target.cwd, query])
      : null;
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<number | undefined>;
  }>({
    targetKey,
    cursors: INITIAL_BRANCH_CURSORS,
  });
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS;
  const pageAtoms = useMemo(
    () =>
      target.environmentId !== null && target.cwd !== null
        ? cursors.map((cursor) =>
            vcsEnvironment.listRefs({
              environmentId: target.environmentId!,
              input: {
                cwd: target.cwd!,
                ...(query.length > 0 ? { query } : {}),
                ...(cursor === undefined ? {} : { cursor }),
                limit: VCS_REF_LIST_LIMIT,
              },
            }),
          )
        : [],
    [cursors, query, target.cwd, target.environmentId],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`mobile:vcs-ref-pages:${targetKey ?? "empty"}`),
      ),
    [pageAtoms, targetKey],
  );
  const results = useAtomValue(pagesAtom);
  const values = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
    return value === null ? [] : [value];
  });
  const refs = new Map<string, VcsRef>();
  for (const value of values) {
    for (const ref of value.refs) {
      refs.set(ref.name, ref);
    }
  }
  const first = values[0] ?? null;
  const last = values.at(-1) ?? null;
  const data: VcsListRefsResult | null =
    first === null || last === null
      ? null
      : {
          refs: [...refs.values()],
          isRepo: first.isRepo,
          hasPrimaryRemote: first.hasPrimaryRemote,
          nextCursor: last.nextCursor,
          totalCount: Math.max(...values.map((value) => value.totalCount)),
        };
  const lastResult = results.at(-1);
  const isFetchingNextPage =
    results.length > 1 &&
    lastResult?.waiting === true &&
    Option.isNone(AsyncResult.value(lastResult));
  const failed = results.find((result) => result._tag === "Failure");
  const error =
    failed?._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(failed.cause);
          return cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : "Failed to load refs.";
        })()
      : null;
  const refresh = useCallback(() => {
    const firstPage = pageAtoms[0];
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS });
    if (firstPage !== undefined) {
      appAtomRegistry.refresh(firstPage);
    }
  }, [pageAtoms, targetKey]);
  const loadNext = useCallback(() => {
    if (targetKey === null || data?.nextCursor === null || data?.nextCursor === undefined) {
      return;
    }
    setPagination((current) => {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS;
      return currentCursors.includes(data.nextCursor!)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, data.nextCursor!] };
    });
  }, [data?.nextCursor, targetKey]);

  return {
    data,
    refs: data?.refs ?? EMPTY_REFS,
    error,
    isPending: results.some((result) => result.waiting),
    isFetchingNextPage,
    refresh,
    loadNext,
  };
}

export function useComposerPathSearch(target: ComposerPathSearchTarget) {
  const normalizedTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: normalizeComposerPathSearchQuery(target.query),
    }),
    [target.cwd, target.environmentId, target.query],
  );
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS);
  const searchTarget: ProjectPathSearchSyncTarget | null =
    debouncedTarget.environmentId !== null &&
    debouncedTarget.cwd !== null &&
    debouncedTarget.query.length > 0
      ? {
          environmentId: debouncedTarget.environmentId,
          cwd: debouncedTarget.cwd,
          query: debouncedTarget.query,
          limit: COMPOSER_PATH_SEARCH_LIMIT,
        }
      : null;
  const searchKey = searchTarget === null ? null : JSON.stringify(searchTarget);
  useAtomValue(
    searchKey === null ? EMPTY_PROJECT_PATH_SEARCH_SYNC_ATOM : projectPathSearchSyncAtom(searchKey),
  );
  const result = useEnvironmentQuery(
    searchTarget !== null
      ? projectEnvironment.searchEntries({
          environmentId: searchTarget.environmentId,
          input: {
            cwd: searchTarget.cwd,
            query: searchTarget.query,
            limit: searchTarget.limit,
          },
        })
      : null,
  );

  return {
    entries: result.data?.entries ?? [],
    error: result.error,
    isPending: normalizedTarget.query !== debouncedTarget.query || result.isPending,
    refresh: result.refresh,
  };
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled = true,
) {
  const target = enabled && environmentId !== null && cwd !== null ? { environmentId, cwd } : null;
  const key = target === null ? null : JSON.stringify([target.environmentId, target.cwd]);
  useAtomValue(key === null ? EMPTY_PROJECT_PATH_SEARCH_SYNC_ATOM : projectEntriesSyncAtom(key));
  return useEnvironmentQuery<ProjectListEntriesResult, unknown>(
    target === null
      ? null
      : projectEnvironment.listEntries({
          environmentId: target.environmentId,
          input: { cwd: target.cwd },
        }),
  );
}

export function useProviderContextSkills(target: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
}) {
  const result = useEnvironmentQuery(
    target.environmentId !== null && target.instanceId !== null
      ? serverEnvironment.providerSkills({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId, cwd: target.cwd },
        })
      : null,
  );
  return {
    skills: result.data?.skills ?? null,
    isPending: result.isPending,
  };
}

export function useCheckpointDiff(target: CheckpointDiffTarget) {
  const targets = useMemo(
    () => buildCheckpointDiffTargets(target),
    [
      target.environmentId,
      target.fromTurnCount,
      target.ignoreWhitespace,
      target.threadId,
      target.toTurnCount,
    ],
  );
  const fullThread = useEnvironmentQuery(
    targets.fullThread === null
      ? null
      : orchestrationEnvironment.fullThreadDiff(targets.fullThread),
  );
  const turn = useEnvironmentQuery(
    targets.turn === null ? null : orchestrationEnvironment.turnDiff(targets.turn),
  );
  return targets.fullThread === null ? turn : fullThread;
}
