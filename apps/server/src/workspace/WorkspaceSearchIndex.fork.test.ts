// @effect-diagnostics nodeBuiltinImport:off
// Fork: symlink-aware explorer and search, hidden-root visibility
// (FORK_FEATURES.md). The native @ff-labs/fff-node index neither follows
// symlinks nor lists root dotfiles; these tests stub it empty so every entry
// below comes from the fork's supplemental walk.
import { FileFinder } from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const makeTempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

const emptySearchResult = () => ({
  ok: true as const,
  value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
});

/** A native finder that indexes nothing, so only the supplemental walk contributes. */
function stubEmptyNativeIndex(): void {
  const finder = {
    destroy: vi.fn(),
    waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    mixedSearch: vi.fn(emptySearchResult),
    fileSearch: vi.fn(emptySearchResult),
    directorySearch: vi.fn(() => ({
      ok: true as const,
      value: { items: [], scores: [], totalMatched: 0 },
    })),
  } as unknown as FileFinder;
  vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
}

it.effect("list includes the subtree of root-level directory symlinks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("t3-search-index-");
      const target = NodePath.join(cwd, "real-lib");
      const other = NodePath.join(cwd, "other-lib");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(target);
        await NodeFSP.writeFile(NodePath.join(target, "README.md"), "hello");
        await NodeFSP.mkdir(NodePath.join(target, "nested"));
        await NodeFSP.writeFile(NodePath.join(target, "nested", "deep.txt"), "deep");
        await NodeFSP.mkdir(other);
        await NodeFSP.writeFile(NodePath.join(other, "inner.txt"), "inner");
        // A symlink inside the symlinked tree must be followed too.
        await NodeFSP.symlink(other, NodePath.join(target, "alias"));
        // A broken symlink must be skipped without failing the walk.
        await NodeFSP.symlink(NodePath.join(cwd, "missing"), NodePath.join(target, "broken"));
        await NodeFSP.symlink(target, NodePath.join(cwd, "linked"));
      });
      stubEmptyNativeIndex();

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.list();

      expect(result.entries.map((entry) => entry.path)).toEqual([
        "linked",
        "linked/alias",
        "linked/alias/inner.txt",
        "linked/nested",
        "linked/nested/deep.txt",
        "linked/README.md",
      ]);
      expect(result.entries.find((entry) => entry.path === "linked")?.kind).toBe("directory");
      expect(result.entries.find((entry) => entry.path === "linked/README.md")?.kind).toBe("file");
      // Only the entries that are themselves links carry the symlink flag.
      expect(result.entries.find((entry) => entry.path === "linked")?.symlink).toBe(true);
      expect(result.entries.find((entry) => entry.path === "linked/alias")?.symlink).toBe(true);
      expect(result.entries.find((entry) => entry.path === "linked/README.md")?.symlink).toBe(
        undefined,
      );
      expect(result.truncated).toBe(false);
    }),
  ),
);

it.effect("list includes hidden root entries but excludes .git and .DS_Store", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("t3-search-index-");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(cwd, ".agents"));
        await NodeFSP.writeFile(NodePath.join(cwd, ".agents", "skills.md"), "skills");
        await NodeFSP.writeFile(NodePath.join(cwd, ".gitignore"), "node_modules\n");
        await NodeFSP.writeFile(NodePath.join(cwd, ".DS_Store"), "junk");
        await NodeFSP.mkdir(NodePath.join(cwd, ".git"));
        await NodeFSP.writeFile(NodePath.join(cwd, ".git", "HEAD"), "ref");
        await NodeFSP.writeFile(NodePath.join(cwd, "visible.txt"), "visible");
        await NodeFSP.symlink(NodePath.join(cwd, "visible.txt"), NodePath.join(cwd, "linked-file"));
      });
      stubEmptyNativeIndex();

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.list();

      expect(result.entries.map((entry) => entry.path)).toEqual([
        ".agents",
        ".agents/skills.md",
        ".gitignore",
        "linked-file",
      ]);
      expect(result.entries.find((entry) => entry.path === ".agents")?.kind).toBe("directory");
      expect(result.entries.find((entry) => entry.path === "linked-file")?.kind).toBe("file");
      expect(result.entries.find((entry) => entry.path === "linked-file")?.symlink).toBe(true);
      expect(result.entries.find((entry) => entry.path === ".agents")?.symlink).toBe(undefined);
    }),
  ),
);

it.effect("list follows symlinks that resolve outside the workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("t3-search-index-workspace-");
      const outside = yield* makeTempDir("t3-search-index-outside-");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(outside, "notes.txt"), "notes");
        await NodeFSP.symlink(outside, NodePath.join(cwd, "outside"));
      });
      stubEmptyNativeIndex();

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      expect((yield* searchIndex.list()).entries).toEqual([
        { path: "outside", kind: "directory", symlink: true },
        { path: "outside/notes.txt", kind: "file" },
      ]);
    }),
  ),
);

it.effect("search matches files inside symlinked directory subtrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("t3-search-index-");
      const target = NodePath.join(cwd, "real-lib");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(target);
        await NodeFSP.writeFile(NodePath.join(target, "README.md"), "hello");
        await NodeFSP.symlink(target, NodePath.join(cwd, "linked"));
      });
      stubEmptyNativeIndex();

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);

      const mixed = yield* searchIndex.search("readme", 10);
      expect(mixed.entries).toEqual([{ kind: "file", path: "linked/README.md" }]);

      const files = yield* searchIndex.search("readme", 10, "file");
      expect(files.entries).toEqual([{ kind: "file", path: "linked/README.md" }]);

      const directories = yield* searchIndex.search("linked", 10, "directory");
      expect(directories.entries).toEqual([{ kind: "directory", path: "linked", symlink: true }]);

      const limited = yield* searchIndex.search("linked", 1);
      expect(limited.entries).toHaveLength(1);
      expect(limited.truncated).toBe(true);

      const misses = yield* searchIndex.search("nomatch", 10);
      expect(misses.entries).toEqual([]);
    }),
  ),
);
