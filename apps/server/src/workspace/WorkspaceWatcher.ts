// @effect-diagnostics nodeBuiltinImport:off
import type { AsyncSubscription } from "@parcel/watcher";
import * as ParcelWatcher from "@parcel/watcher";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";

const WATCHER_DEBOUNCE = Duration.millis(300);
const WATCHER_IGNORE = ["**/.git/**"];
const WATCH_ROOT_DISCOVERY_MAX_ENTRIES = 5_000;
const WATCH_ROOT_EXCLUDED_NAMES = new Set([".git", ".DS_Store", ".convex"]);

export interface WorkspaceChangedEvent {
  readonly cwd: string;
}

export class WorkspaceWatchStartFailed extends Schema.TaggedErrorClass<WorkspaceWatchStartFailed>()(
  "WorkspaceWatchStartFailed",
  { cwd: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to start the filesystem watcher for '${this.cwd}'.`;
  }
}

/**
 * Watches project workspaces so the file explorer and path search reflect
 * external filesystem changes instead of only app-mediated writes. Each
 * watched workspace gets one recursive @parcel/watcher subscription whose
 * events debounce into a single `WorkspaceEntries.refresh` plus a change
 * event on `streamChanges`, which clients consume to refetch their entry
 * queries. Workspaces are keyed by resolved real path, so path-spelling
 * differences across clients collapse onto one watcher.
 */
export class WorkspaceWatcher extends Context.Service<
  WorkspaceWatcher,
  {
    readonly streamChanges: (cwd: string) => Stream.Stream<WorkspaceChangedEvent>;
    /**
     * Emits a change event to current subscribers after an out-of-band index
     * refresh, such as a client's manual rescan. No-op without subscribers.
     */
    readonly notifyChanged: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceWatcher") {}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = NodePath.relative(parent, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/**
 * @parcel/watcher does not follow directory symlinks. Discover the real roots
 * of the same supplemental trees the explorer exposes so changes beyond the
 * workspace boundary invalidate the index too.
 */
async function collectSupplementalWatchRoots(cwd: string, realCwd: string): Promise<string[]> {
  const watchRoots = new Set<string>();
  const visitedRealPaths = new Set<string>();
  let visitedEntries = 0;

  const addWatchRoot = (candidate: string) => {
    if (isInsideDirectory(realCwd, candidate)) return;
    for (const existing of watchRoots) {
      if (isInsideDirectory(existing, candidate)) return;
      if (isInsideDirectory(candidate, existing)) watchRoots.delete(existing);
    }
    watchRoots.add(candidate);
  };

  const walkSupplementalDirectory = async (absolutePath: string): Promise<void> => {
    let realPath: string;
    try {
      realPath = await NodeFSP.realpath(absolutePath);
    } catch {
      return;
    }
    if (visitedRealPaths.has(realPath)) return;
    visitedRealPaths.add(realPath);

    let dirents: Array<NodeFS.Dirent>;
    try {
      dirents = await NodeFSP.readdir(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (visitedEntries >= WATCH_ROOT_DISCOVERY_MAX_ENTRIES) return;
      visitedEntries += 1;
      if (WATCH_ROOT_EXCLUDED_NAMES.has(dirent.name)) continue;
      const childPath = NodePath.join(absolutePath, dirent.name);
      if (dirent.isSymbolicLink()) {
        try {
          if (!(await NodeFSP.stat(childPath)).isDirectory()) continue;
          const target = await NodeFSP.realpath(childPath);
          addWatchRoot(target);
          await walkSupplementalDirectory(childPath);
        } catch {
          continue;
        }
      } else if (dirent.isDirectory()) {
        await walkSupplementalDirectory(childPath);
      }
    }
  };

  let rootDirents: Array<NodeFS.Dirent>;
  try {
    rootDirents = await NodeFSP.readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirent of rootDirents) {
    if (visitedEntries >= WATCH_ROOT_DISCOVERY_MAX_ENTRIES) break;
    if (WATCH_ROOT_EXCLUDED_NAMES.has(dirent.name)) continue;
    const isHidden = dirent.name.startsWith(".");
    if (!dirent.isSymbolicLink() && !isHidden) continue;
    const entryPath = NodePath.join(cwd, dirent.name);
    try {
      if (!(await NodeFSP.stat(entryPath)).isDirectory()) continue;
      if (dirent.isSymbolicLink()) addWatchRoot(await NodeFSP.realpath(entryPath));
      await walkSupplementalDirectory(entryPath);
    } catch {
      continue;
    }
  }

  return [...watchRoots];
}

interface WorkspaceWatchState {
  readonly realCwd: string;
  readonly rawEvents: PubSub.PubSub<void>;
  readonly changes: PubSub.PubSub<WorkspaceChangedEvent>;
  readonly subscriptions: ReadonlyArray<AsyncSubscription>;
  readonly consumerScope: Scope.Closeable;
  readonly cwdRetainers: Map<string, number>;
  retainers: number;
  closed: boolean;
}

export const make = Effect.gen(function* () {
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const stateLock = yield* Semaphore.make(1);
  const states = new Map<string, WorkspaceWatchState>();

  const resolveRealCwd = (inputCwd: string) =>
    Effect.tryPromise(() => NodeFSP.realpath(inputCwd)).pipe(
      Effect.map((realCwd): string | null => realCwd),
      Effect.orElseSucceed(() => null),
    );

  const closeState = Effect.fn("WorkspaceWatcher.closeState")(function* (
    state: WorkspaceWatchState,
  ) {
    if (state.closed) return;
    state.closed = true;
    yield* Effect.all(
      [
        Scope.close(state.consumerScope, Exit.void).pipe(Effect.ignore),
        Effect.forEach(
          state.subscriptions,
          (subscription) => Effect.promise(() => subscription.unsubscribe()).pipe(Effect.ignore),
          { discard: true },
        ),
        PubSub.shutdown(state.rawEvents),
        PubSub.shutdown(state.changes),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });

  const startState = Effect.fn("WorkspaceWatcher.startState")(function* (
    inputCwd: string,
    realCwd: string,
  ) {
    const rawEvents = yield* PubSub.unbounded<void>();
    const changes = yield* PubSub.unbounded<WorkspaceChangedEvent>();
    const consumerScope = yield* Scope.make("sequential");
    const callback = (error: Error | null) => {
      if (error) return;
      PubSub.publishUnsafe(rawEvents, undefined);
    };
    const primarySubscription = yield* Effect.tryPromise({
      try: () => ParcelWatcher.subscribe(realCwd, callback, { ignore: WATCHER_IGNORE }),
      catch: (cause) => new WorkspaceWatchStartFailed({ cwd: inputCwd, cause }),
    }).pipe(
      Effect.onError(() =>
        Effect.all(
          [
            Scope.close(consumerScope, Exit.void).pipe(Effect.ignore),
            PubSub.shutdown(rawEvents),
            PubSub.shutdown(changes),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );
    const supplementalRoots = yield* Effect.promise(() =>
      collectSupplementalWatchRoots(inputCwd, realCwd),
    );
    const supplementalSubscriptions = yield* Effect.forEach(
      supplementalRoots,
      (watchRoot) =>
        Effect.tryPromise({
          try: () => ParcelWatcher.subscribe(watchRoot, callback, { ignore: WATCHER_IGNORE }),
          catch: (cause) => new WorkspaceWatchStartFailed({ cwd: watchRoot, cause }),
        }).pipe(
          Effect.tapError((cause) => Effect.logWarning(cause.message, { cwd: watchRoot })),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: "unbounded" },
    );
    const state: WorkspaceWatchState = {
      realCwd,
      rawEvents,
      changes,
      subscriptions: [
        primarySubscription,
        ...supplementalSubscriptions.filter(
          (subscription): subscription is AsyncSubscription => subscription !== null,
        ),
      ],
      consumerScope,
      cwdRetainers: new Map(),
      retainers: 0,
      closed: false,
    };

    yield* Stream.fromPubSub(rawEvents).pipe(
      Stream.debounce(WATCHER_DEBOUNCE),
      Stream.mapEffect(() =>
        Effect.forEach(
          [...state.cwdRetainers.keys()],
          (cwd) => workspaceEntries.refresh(cwd).pipe(Effect.ignoreCause({ log: true })),
          { discard: true },
        ).pipe(Effect.andThen(PubSub.publish(changes, { cwd: realCwd }))),
      ),
      Stream.runDrain,
      Effect.forkIn(consumerScope),
      Effect.asVoid,
    );

    return state;
  });

  const acquireState = Effect.fn("WorkspaceWatcher.acquireState")(function* (inputCwd: string) {
    const realCwd = yield* resolveRealCwd(inputCwd);
    if (realCwd === null) return null;
    return yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        let state: WorkspaceWatchState | null = states.get(realCwd) ?? null;
        if (state === null) {
          state = yield* startState(inputCwd, realCwd).pipe(
            Effect.tapError((cause) => Effect.logWarning(cause.message, { cwd: inputCwd })),
            Effect.orElseSucceed(() => null),
          );
          if (state === null) return null;
          states.set(realCwd, state);
        }
        state.retainers += 1;
        state.cwdRetainers.set(inputCwd, (state.cwdRetainers.get(inputCwd) ?? 0) + 1);
        return state;
      }),
    );
  });

  const releaseState = Effect.fn("WorkspaceWatcher.releaseState")(function* (
    state: WorkspaceWatchState | null,
    inputCwd: string,
  ) {
    if (state === null) return;
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        if (state.closed) return;
        const cwdRetainers = state.cwdRetainers.get(inputCwd) ?? 0;
        if (cwdRetainers <= 1) state.cwdRetainers.delete(inputCwd);
        else state.cwdRetainers.set(inputCwd, cwdRetainers - 1);
        state.retainers = Math.max(0, state.retainers - 1);
        if (state.retainers > 0) return;
        if (states.get(state.realCwd) === state) states.delete(state.realCwd);
        yield* closeState(state);
      }),
    );
  });

  const streamChanges: WorkspaceWatcher["Service"]["streamChanges"] = (inputCwd) =>
    Stream.unwrap(
      Effect.acquireRelease(acquireState(inputCwd), (state) => releaseState(state, inputCwd)).pipe(
        Effect.map((state) =>
          state === null
            ? (Stream.empty as Stream.Stream<WorkspaceChangedEvent>)
            : Stream.fromPubSub(state.changes),
        ),
      ),
    );

  const notifyChanged: WorkspaceWatcher["Service"]["notifyChanged"] = Effect.fn(
    "WorkspaceWatcher.notifyChanged",
  )(function* (inputCwd: string) {
    const realCwd = yield* resolveRealCwd(inputCwd);
    if (realCwd === null) return;
    yield* stateLock.withPermits(1)(
      Effect.suspend(() => {
        const state = states.get(realCwd);
        if (state === undefined || state.closed) return Effect.void;
        return PubSub.publish(state.changes, { cwd: realCwd }).pipe(Effect.asVoid);
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    stateLock.withPermits(1)(
      Effect.gen(function* () {
        const activeStates = [...states.values()];
        states.clear();
        yield* Effect.forEach(activeStates, closeState, { discard: true });
      }),
    ),
  );

  return WorkspaceWatcher.of({ notifyChanged, streamChanges });
});

/**
 * Requires the same WorkspaceEntries instance that serves list/search so
 * watcher-driven refreshes invalidate the caches those RPCs read.
 */
export const layer = Layer.effect(WorkspaceWatcher, make);
