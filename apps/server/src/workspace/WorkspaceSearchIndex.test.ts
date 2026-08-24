// @effect-diagnostics nodeBuiltinImport:off
import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("preserves unexpected FileFinder creation failures", () =>
  Effect.gen(function* () {
    const cause = new Error("native initialization failed");
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw cause;
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "FileFinder.create threw unexpectedly.",
      cause,
    });
  }),
);

it.effect("keeps returned FileFinder creation diagnostics out of the cause chain", () =>
  Effect.gen(function* () {
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: false,
      error: "native index rejected the directory",
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "native index rejected the directory",
    });
    expect(error.cause).toBeUndefined();
  }),
);

it.effect("waits for the full content index warmup before returning", () =>
  Effect.gen(function* () {
    const waitForIndexReady = vi.fn(async () => ({ ok: true as const, value: true }));
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady,
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content"));

    expect(waitForIndexReady).toHaveBeenCalledWith(15_000);
  }),
);

it.effect("preserves a full-index warmup timeout as a structured error", () =>
  Effect.gen(function* () {
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexScanTimedOut",
      cwd: "/workspace/project",
      timeout: "15 seconds",
    });
  }),
);

it.effect("preserves FileFinder destroy failures as structured defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native destroy failed");
    const finder = {
      destroy: vi.fn(() => {
        throw cause;
      }),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const exit = yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")).pipe(
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed);
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexDestroyFailed",
        cwd: "/workspace/project",
        cause,
      });
    }
  }),
);

it.effect("preserves search and refresh failures with operation context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const searchCause = new Error("native search failed");
      const refreshCause = new Error("native scan failed");
      const contentSearchCause = new Error("native grep failed");
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => {
          throw searchCause;
        }),
        grep: vi.fn(() => {
          throw contentSearchCause;
        }),
        scanFiles: vi.fn(() => {
          throw refreshCause;
        }),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const contentSearchError = yield* Effect.flip(
        searchIndex.searchContents({
          query,
          limit: 3,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        }),
      );
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "FileFinder.mixedSearch threw unexpectedly.",
        cause: searchCause,
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(contentSearchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 3,
        reason: "FileFinder.grep threw unexpectedly.",
        cause: contentSearchCause,
      });
      expect(contentSearchError).not.toHaveProperty("query");
      expect(contentSearchError.message).not.toMatch(/Bearer|secret-token/);
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "FileFinder.scanFiles threw unexpectedly.",
        cause: refreshCause,
      });
    }),
  ),
);

it.effect("keeps returned search diagnostics out of the cause chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({ ok: false, error: "native query rejected" })),
        scanFiles: vi.fn(() => ({ ok: false, error: "native refresh rejected" })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "native query rejected",
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(searchError.cause).toBeUndefined();
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "native refresh rejected",
      });
      expect(refreshError.cause).toBeUndefined();
    }),
  ),
);

it.effect("list includes the subtree of root-level directory symlinks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-search-index-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
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

      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({
          ok: true as const,
          value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

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
      expect(result.truncated).toBe(false);
    }),
  ),
);

it.effect("list includes hidden root entries but excludes .git and .DS_Store", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-search-index-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
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

      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({
          ok: true as const,
          value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

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
    }),
  ),
);

it.effect("list follows symlinks that resolve outside the workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directories = yield* Effect.acquireRelease(
        Effect.promise(async () => ({
          cwd: await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-search-index-workspace-")),
          outside: await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "t3-search-index-outside-"),
          ),
        })),
        ({ cwd, outside }) =>
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(cwd, { recursive: true, force: true }),
              NodeFSP.rm(outside, { recursive: true, force: true }),
            ]).then(() => undefined),
          ),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(directories.outside, "notes.txt"), "notes");
        await NodeFSP.symlink(directories.outside, NodePath.join(directories.cwd, "outside"));
      });

      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({
          ok: true as const,
          value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(directories.cwd);
      expect((yield* searchIndex.list()).entries).toEqual([
        { path: "outside", kind: "directory" },
        { path: "outside/notes.txt", kind: "file" },
      ]);
    }),
  ),
);

it.effect("search matches files inside symlinked directory subtrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-search-index-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const target = NodePath.join(cwd, "real-lib");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(target);
        await NodeFSP.writeFile(NodePath.join(target, "README.md"), "hello");
        await NodeFSP.symlink(target, NodePath.join(cwd, "linked"));
      });

      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({
          ok: true as const,
          value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
        })),
        fileSearch: vi.fn(() => ({
          ok: true as const,
          value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
        })),
        directorySearch: vi.fn(() => ({
          ok: true as const,
          value: { items: [], scores: [], totalMatched: 0 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);

      const mixed = yield* searchIndex.search("readme", 10);
      expect(mixed.entries).toEqual([{ kind: "file", path: "linked/README.md" }]);

      const files = yield* searchIndex.search("readme", 10, "file");
      expect(files.entries).toEqual([{ kind: "file", path: "linked/README.md" }]);

      const directories = yield* searchIndex.search("linked", 10, "directory");
      expect(directories.entries).toEqual([{ kind: "directory", path: "linked" }]);

      const misses = yield* searchIndex.search("nomatch", 10);
      expect(misses.entries).toEqual([]);
    }),
  ),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content");
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ),
);
