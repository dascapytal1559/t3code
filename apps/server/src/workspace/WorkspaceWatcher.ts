// @effect-diagnostics nodeBuiltinImport:off
import type { AsyncSubscription } from "@parcel/watcher";
import * as ParcelWatcher from "@parcel/watcher";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";

const WATCHER_DEBOUNCE = Duration.millis(300);
// Keep the watch scoped to what the explorer renders; .git is huge and
// node_modules churns constantly during installs.
const WATCHER_IGNORE = ["**/.git/**", "**/node_modules/**"];

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
    /** Idempotent per workspace; safe to call on every entries request. */
    readonly ensureWatching: (cwd: string) => Effect.Effect<void>;
    readonly streamChanges: (cwd: string) => Stream.Stream<WorkspaceChangedEvent>;
  }
>()("t3/workspace/WorkspaceWatcher") {}

export const make = Effect.gen(function* () {
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const scope = yield* Effect.scope;

  // Raw fs events keyed by resolved workspace path; the debounced consumer
  // turns each burst into one index refresh plus one client-visible event.
  const rawEvents = yield* PubSub.unbounded<{ readonly realCwd: string }>();
  const changes = yield* PubSub.unbounded<WorkspaceChangedEvent>();
  // Storing the start promise itself makes concurrent ensureWatching calls
  // start at most one watcher and one consumer per workspace.
  const subscriptions = new Map<string, Promise<AsyncSubscription>>();
  const consumers = new Set<string>();

  const ensureWatching = Effect.fn("WorkspaceWatcher.ensureWatching")(function* (inputCwd: string) {
    let realCwd: string;
    try {
      realCwd = yield* Effect.promise(() => NodeFSP.realpath(inputCwd));
    } catch {
      return;
    }
    let startPromise = subscriptions.get(realCwd);
    if (!startPromise) {
      startPromise = ParcelWatcher.subscribe(
        realCwd,
        (error) => {
          if (error) return;
          void Effect.runPromise(PubSub.publish(rawEvents, { realCwd })).catch(() => {});
        },
        { ignore: WATCHER_IGNORE },
      ).then(
        (subscription) => {
          subscriptions.set(realCwd, Promise.resolve(subscription));
          return subscription;
        },
        (cause) => {
          subscriptions.delete(realCwd);
          throw cause;
        },
      );
      subscriptions.set(realCwd, startPromise);
    }

    yield* Effect.tryPromise({
      try: () => startPromise,
      catch: (cause) => new WorkspaceWatchStartFailed({ cwd: inputCwd, cause }),
    }).pipe(
      Effect.tapError((cause) => Effect.logWarning(cause.message, { cwd: inputCwd })),
      Effect.ignoreCause({ log: true }),
    );

    if (consumers.has(realCwd)) return;
    consumers.add(realCwd);

    yield* Stream.fromPubSub(rawEvents).pipe(
      Stream.filter((event) => event.realCwd === realCwd),
      Stream.debounce(WATCHER_DEBOUNCE),
      Stream.mapEffect(() =>
        workspaceEntries
          .refresh(inputCwd)
          .pipe(
            Effect.ignoreCause({ log: true }),
            Effect.andThen(PubSub.publish(changes, { cwd: realCwd })),
          ),
      ),
      Stream.runDrain,
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  const streamChanges: WorkspaceWatcher["Service"]["streamChanges"] = (inputCwd) =>
    Stream.unwrap(
      Effect.gen(function* () {
        let realCwd: string;
        try {
          realCwd = yield* Effect.promise(() => NodeFSP.realpath(inputCwd));
        } catch {
          return Stream.empty as Stream.Stream<WorkspaceChangedEvent>;
        }
        return Stream.fromPubSub(changes).pipe(Stream.filter((event) => event.cwd === realCwd));
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      Promise.allSettled(
        [...subscriptions.values()].map((promise) =>
          promise.then((subscription) => subscription.unsubscribe()).catch(() => {}),
        ),
      ).then(() => {}),
    ).pipe(Effect.asVoid),
  );

  return WorkspaceWatcher.of({ ensureWatching, streamChanges });
});

/**
 * Requires the same WorkspaceEntries instance that serves list/search so
 * watcher-driven refreshes invalidate the caches those RPCs read.
 */
export const layer = Layer.effect(WorkspaceWatcher, make);
