import type { FileTreeBatchOperation, GitStatusEntry } from "@pierre/trees";
import { describe, expect, it } from "@effect/vitest";

import { applyDirListing, createStore, trackEntry } from "./useLazyFileTree.ts";

const recordingModel = () => {
  const batches: FileTreeBatchOperation[][] = [];
  const gitStatuses: Array<ReadonlyArray<GitStatusEntry> | undefined> = [];
  return {
    batches,
    gitStatuses,
    model: {
      batch: (ops: readonly FileTreeBatchOperation[]) => void batches.push([...ops]),
      setGitStatus: (statuses?: ReadonlyArray<GitStatusEntry>) => void gitStatuses.push(statuses),
    },
  };
};

describe("applyDirListing", () => {
  it("adds a fresh listing and tracks directories as unloaded", () => {
    const store = createStore(1);
    const { batches, model } = recordingModel();

    applyDirListing(store, model, "", [
      { path: "src", kind: "directory" },
      { path: "readme.md", kind: "file" },
      { path: "link.ts", kind: "file", symlink: true },
    ]);

    expect(batches).toEqual([
      [
        { type: "add", path: "src/" },
        { type: "add", path: "readme.md" },
        { type: "add", path: "link.ts" },
      ],
    ]);
    expect(store.loadedDirs.has("")).toBe(true);
    expect(store.unloadedDirs.has("src")).toBe(true);
    expect(store.entryKinds.get("src")).toBe("directory");
    expect(store.symlinkTreePaths.has("link.ts")).toBe(true);
  });

  it("maps ignored entries to the tree's built-in Git status", () => {
    const store = createStore(1);
    const { gitStatuses, model } = recordingModel();

    applyDirListing(store, model, "", [
      { path: "cache", kind: "directory", ignored: true },
      { path: "keep.ts", kind: "file" },
    ]);
    applyDirListing(store, model, "cache", [
      { path: "cache/result.json", kind: "file", ignored: true },
    ]);

    expect(gitStatuses.at(-1)).toEqual([
      { path: "cache/", status: "ignored" },
      { path: "cache/result.json", status: "ignored" },
    ]);
  });

  it("diffs a refreshed listing into granular add and remove operations", () => {
    const store = createStore(1);
    const { batches, model } = recordingModel();
    applyDirListing(store, model, "", [
      { path: "src", kind: "directory" },
      { path: "old.md", kind: "file" },
    ]);
    applyDirListing(store, model, "src", [{ path: "src/index.ts", kind: "file" }]);

    applyDirListing(store, model, "", [
      { path: "src", kind: "directory" },
      { path: "new.md", kind: "file" },
    ]);

    expect(batches.at(-1)).toEqual([
      { type: "remove", path: "old.md", recursive: true },
      { type: "add", path: "new.md" },
    ]);
    // The unchanged src subtree keeps its loaded children.
    expect(store.loadedDirs.has("src")).toBe(true);
    expect(store.entryKinds.get("src/index.ts")).toBe("file");
  });

  it("purges a removed directory's loaded subtree", () => {
    const store = createStore(1);
    const { batches, model } = recordingModel();
    applyDirListing(store, model, "", [{ path: "src", kind: "directory" }]);
    applyDirListing(store, model, "src", [{ path: "src/index.ts", kind: "file" }]);

    applyDirListing(store, model, "", []);

    expect(batches.at(-1)).toEqual([{ type: "remove", path: "src/", recursive: true }]);
    expect(store.loadedDirs.has("src")).toBe(false);
    expect(store.entryKinds.has("src/index.ts")).toBe(false);
    expect(store.unloadedDirs.has("src")).toBe(false);
  });

  it("replaces an entry whose kind flipped", () => {
    const store = createStore(1);
    const { batches, model } = recordingModel();
    applyDirListing(store, model, "", [{ path: "thing", kind: "file" }]);

    applyDirListing(store, model, "", [{ path: "thing", kind: "directory" }]);

    expect(batches.at(-1)).toEqual([
      { type: "remove", path: "thing", recursive: true },
      { type: "add", path: "thing/" },
    ]);
    expect(store.entryKinds.get("thing")).toBe("directory");
    expect(store.unloadedDirs.has("thing")).toBe(true);
  });

  it("keeps search-enriched rows that the real listing confirms", () => {
    const store = createStore(1);
    const { batches, model } = recordingModel();
    applyDirListing(store, model, "", [{ path: "src", kind: "directory" }]);
    // Search enrichment learns about a nested file before src loads.
    trackEntry(store, { path: "src/deep", kind: "directory" });
    trackEntry(store, { path: "src/deep/file.ts", kind: "file" });

    applyDirListing(store, model, "src", [
      { path: "src/deep", kind: "directory" },
      { path: "src/other.ts", kind: "file" },
    ]);

    // src/deep already exists in the tree, so only the new sibling is added.
    expect(batches.at(-1)).toEqual([{ type: "add", path: "src/other.ts" }]);
    expect(store.unloadedDirs.has("src/deep")).toBe(true);
  });
});
