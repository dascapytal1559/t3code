// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceWatcher from "./WorkspaceWatcher.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const makeTempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-watcher-"))),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);

function stubEntriesLayer(
  refreshCalls: Ref.Ref<Array<string>>,
  refreshed: Deferred.Deferred<void>,
) {
  return Layer.effect(
    WorkspaceEntries.WorkspaceEntries,
    Effect.succeed(
      WorkspaceEntries.WorkspaceEntries.of({
        browse: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        search: () => Effect.die("not used"),
        searchContents: () => Effect.die("not used"),
        refresh: (cwd) =>
          Effect.gen(function* () {
            yield* Ref.update(refreshCalls, (calls) => [...calls, cwd]);
            yield* Deferred.succeed(refreshed, undefined);
          }),
      }),
    ),
  );
}

// The layer must wrap the whole program, not just the service lookup:
// Effect.provide releases the layer's scope when the wrapped effect ends,
// which would tear down the native watcher mid-test.
it.live("refreshes workspace entries after external filesystem changes", () =>
  Effect.gen(function* () {
    const refreshCalls = yield* Ref.make<Array<string>>([]);
    const refreshed = yield* Deferred.make<void>();
    const callCount = yield* Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const watcher = yield* WorkspaceWatcher.WorkspaceWatcher;
      yield* watcher.ensureWatching(cwd);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "new-file.txt"), "x"));
      yield* Deferred.await(refreshed);
      return yield* Ref.get(refreshCalls);
    }).pipe(
      Effect.provide(
        WorkspaceWatcher.layer.pipe(Layer.provide(stubEntriesLayer(refreshCalls, refreshed))),
      ),
    );

    expect(callCount.length).toBeGreaterThan(0);
  }),
);

it.live("emits a change event on the cwd stream", () =>
  Effect.gen(function* () {
    const refreshCalls = yield* Ref.make<Array<string>>([]);
    const refreshed = yield* Deferred.make<void>();
    const outcome = yield* Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const realCwd = yield* Effect.promise(() => NodeFSP.realpath(cwd));
      const watcher = yield* WorkspaceWatcher.WorkspaceWatcher;
      yield* watcher.ensureWatching(cwd);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(cwd, "other-file.txt"), "x"),
      ).pipe(Effect.delay(Duration.millis(50)), Effect.forkScoped);
      const firstEvent = yield* Stream.runHead(watcher.streamChanges(cwd));
      return { realCwd, firstEvent };
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(new Error("no change event within 10s")),
      }),
      Effect.provide(
        WorkspaceWatcher.layer.pipe(Layer.provide(stubEntriesLayer(refreshCalls, refreshed))),
      ),
    );

    expect(Option.isSome(outcome.firstEvent)).toBe(true);
    if (Option.isSome(outcome.firstEvent)) {
      expect(outcome.firstEvent.value.cwd).toBe(outcome.realCwd);
    }
  }),
);
