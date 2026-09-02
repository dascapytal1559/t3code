// Fork: lazy per-directory file explorer on mobile (FORK_FEATURES.md).
import { describe, expect, it } from "vite-plus/test";

import { applyDirListing, createStore, mergeLoadedEntries } from "./lazyEntriesStore";

describe("lazy entries store", () => {
  it("records a listing and marks the directory loaded", () => {
    const store = createStore(1);

    applyDirListing(store, "", [
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ]);

    expect([...store.loadedDirs]).toEqual([""]);
    expect(store.entryKinds.get("src")).toBe("directory");
    expect(mergeLoadedEntries(store, undefined)).toEqual([
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ]);
  });

  it("drops the loaded subtree of a directory that vanished on refresh", () => {
    const store = createStore(1);
    applyDirListing(store, "", [{ path: "src", kind: "directory" }]);
    applyDirListing(store, "src", [{ path: "src/index.ts", kind: "file" }]);

    applyDirListing(store, "", [{ path: "README.md", kind: "file" }]);

    expect(store.loadedDirs.has("src")).toBe(false);
    expect(store.entryKinds.has("src/index.ts")).toBe(false);
    expect(mergeLoadedEntries(store, undefined)).toEqual([{ path: "README.md", kind: "file" }]);
  });

  it("drops the loaded subtree of an entry whose kind flipped", () => {
    const store = createStore(1);
    applyDirListing(store, "", [{ path: "thing", kind: "directory" }]);
    applyDirListing(store, "thing", [{ path: "thing/inner.txt", kind: "file" }]);

    applyDirListing(store, "", [{ path: "thing", kind: "file" }]);

    expect(store.entryKinds.get("thing")).toBe("file");
    expect(store.loadedDirs.has("thing")).toBe(false);
    expect(mergeLoadedEntries(store, undefined)).toEqual([{ path: "thing", kind: "file" }]);
  });

  it("keeps a subtree whose parent entry is unchanged", () => {
    const store = createStore(1);
    applyDirListing(store, "", [{ path: "src", kind: "directory" }]);
    applyDirListing(store, "src", [{ path: "src/index.ts", kind: "file" }]);

    applyDirListing(store, "", [
      { path: "src", kind: "directory" },
      { path: "new.md", kind: "file" },
    ]);

    expect(store.loadedDirs.has("src")).toBe(true);
    expect(mergeLoadedEntries(store, undefined).map((entry) => entry.path)).toEqual([
      "src",
      "new.md",
      "src/index.ts",
    ]);
  });

  it("merges server search matches without duplicating loaded rows", () => {
    const store = createStore(1);
    applyDirListing(store, "", [{ path: "src", kind: "directory" }]);

    const merged = mergeLoadedEntries(store, [
      { path: "src", kind: "directory" },
      { path: "src/deep/match.ts", kind: "file" },
    ]);

    expect(merged.map((entry) => entry.path)).toEqual(["src", "src/deep/match.ts"]);
  });
});
