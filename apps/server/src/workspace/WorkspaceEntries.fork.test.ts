// @effect-diagnostics nodeBuiltinImport:off
// Fork: lazy per-directory file explorer (projects.listDirectory) and the
// fail-open supplemental path filter behind the symlink-aware search
// (FORK_FEATURES.md).
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-fork-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-fork-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.fork.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const listDirectory = (input: { cwd: string; path: string }) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.listDirectory(input);
  });

const searchWorkspaceEntries = (input: { cwd: string; query: string; limit: number }) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

// The exported WorkspaceEntries.layer is memoized by the shared test layer, so
// overriding the supplemental path filter needs a fresh Layer.effect node
// built around the same make.
const entriesLayerWithFilter = (filter: WorkspaceSearchIndex.SupplementalPathFilter) =>
  Layer.effect(WorkspaceEntries.WorkspaceEntries, WorkspaceEntries.make).pipe(
    Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
    Layer.provide(Layer.succeed(WorkspaceSearchIndex.WorkspaceSupplementalPathFilter, filter)),
    Layer.provide(WorkspacePaths.layer),
  );

const realFilterEntriesLayer = Layer.effect(
  WorkspaceEntries.WorkspaceEntries,
  WorkspaceEntries.make,
).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(
    WorkspaceSearchIndex.supplementalPathFilterLayer.pipe(Layer.provide(VcsDriverRegistry.layer)),
  ),
  Layer.provide(WorkspacePaths.layer),
);

const failingIgnoreProbe =
  (cwd: string, detail: string): WorkspaceSearchIndex.SupplementalPathFilter =>
  () =>
    Effect.fail(
      new VcsProcessExitError({ operation: "test", command: "git", cwd, exitCode: 128, detail }),
    );

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntries (fork)", (it) => {
  describe("listDirectory", () => {
    it.effect("lists only direct children of the workspace root", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, ".env.local");

        const result = yield* listDirectory({ cwd, path: "" });

        expect(result.entries).toEqual([
          { path: ".env.local", kind: "file" },
          { path: "README.md", kind: "file" },
          { path: "src", kind: "directory" },
        ]);
      }),
    );

    it.effect("lists a subdirectory with workspace-relative paths", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/index.ts");

        const result = yield* listDirectory({ cwd, path: "src" });

        expect(result.entries).toEqual([
          { path: "src/components", kind: "directory" },
          { path: "src/index.ts", kind: "file" },
        ]);
      }),
    );

    it.effect("excludes the always-hidden entry names", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, ".git/config");
        yield* writeTextFile(cwd, ".DS_Store");
        yield* writeTextFile(cwd, ".convex/data.json");
        yield* writeTextFile(cwd, "keep.ts");

        const result = yield* listDirectory({ cwd, path: "" });

        expect(result.entries).toEqual([{ path: "keep.ts", kind: "file" }]);
      }),
    );

    it.effect("resolves symlink kinds and skips broken symlinks", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "target-dir/inner.ts");
        yield* writeTextFile(cwd, "target.ts");
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(cwd, "target-dir"), path.join(cwd, "linked-dir")),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(cwd, "target.ts"), path.join(cwd, "linked.ts")),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(cwd, "missing.ts"), path.join(cwd, "broken.ts")),
        );

        const result = yield* listDirectory({ cwd, path: "" });

        expect(result.entries).toEqual([
          { path: "linked-dir", kind: "directory", symlink: true },
          { path: "linked.ts", kind: "file", symlink: true },
          { path: "target-dir", kind: "directory" },
          { path: "target.ts", kind: "file" },
        ]);

        const linked = yield* listDirectory({ cwd, path: "linked-dir" });
        expect(linked.entries).toEqual([{ path: "linked-dir/inner.ts", kind: "file" }]);
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const result = yield* listDirectory({ cwd, path: "../outside" }).pipe(Effect.flip);
        expect(result._tag).toBe("WorkspacePathOutsideRootError");
      }),
    );

    it.effect("includes gitignored files and directories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-show-ignored-", git: true });
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\nignored-dir/\n");
        yield* writeTextFile(cwd, "keep.ts");
        yield* writeTextFile(cwd, "ignored.txt");
        yield* writeTextFile(cwd, "ignored-dir/nested.txt");

        const root = yield* listDirectory({ cwd, path: "" }).pipe(
          Effect.provide(realFilterEntriesLayer),
        );
        expect(root.entries).toEqual([
          { path: ".gitignore", kind: "file" },
          { path: "ignored-dir", kind: "directory", ignored: true },
          { path: "ignored.txt", kind: "file", ignored: true },
          { path: "keep.ts", kind: "file" },
        ]);

        const nested = yield* listDirectory({ cwd, path: "ignored-dir" }).pipe(
          Effect.provide(realFilterEntriesLayer),
        );
        expect(nested.entries).toEqual([
          { path: "ignored-dir/nested.txt", kind: "file", ignored: true },
        ]);
      }),
    );

    it.effect("keeps entries undecorated when the ignore probe fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "keep.ts");

        const result = yield* listDirectory({ cwd, path: "" }).pipe(
          Effect.provide(entriesLayerWithFilter(failingIgnoreProbe(cwd, "boom"))),
        );

        expect(result.entries).toEqual([{ path: "keep.ts", kind: "file" }]);
      }),
    );
  });

  describe("search", () => {
    // git check-ignore rejects pathspecs beyond a symbolic link (exit 128);
    // that must not take the whole search down with it.
    it.effect("keeps working when the supplemental path filter fails", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const target = yield* makeTempDir({ prefix: "t3code-workspace-searchlink-target-" });
        yield* writeTextFile(target, "inner.ts");
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-searchlink-" });
        yield* writeTextFile(cwd, "keep.ts");
        yield* Effect.promise(() => NodeFSP.symlink(target, path.join(cwd, "linked")));

        const result = yield* searchWorkspaceEntries({ cwd, query: "inner", limit: 100 }).pipe(
          Effect.provide(
            entriesLayerWithFilter(
              failingIgnoreProbe(
                cwd,
                "fatal: pathspec 'linked/inner.ts' is beyond a symbolic link",
              ),
            ),
          ),
        );

        expect(result.entries.map((entry) => entry.path)).toContain("linked/inner.ts");
      }),
    );
  });
});
