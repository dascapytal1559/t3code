// Fork: symlink-aware explorer (symlink badge) and lazy per-directory explorer
// (muted ignored rows) on mobile (FORK_FEATURES.md).
import { describe, expect, it } from "vite-plus/test";
import type { ProjectEntry } from "@t3tools/contracts";

import { buildFileTree } from "./fileTree";

describe("mobile file tree helpers (fork)", () => {
  it("carries the symlink flag onto the linked entry's node only", () => {
    const tree = buildFileTree([
      { kind: "directory", path: "linked", symlink: true },
      { kind: "file", path: "linked/inner.txt" },
    ] satisfies ReadonlyArray<ProjectEntry>);

    expect(tree[0]?.symlink).toBe(true);
    expect(tree[0]?.children[0]?.symlink).toBe(false);
  });

  it("carries the ignored flag onto the ignored entry's node only", () => {
    const tree = buildFileTree([
      { kind: "directory", path: "cache", ignored: true },
      { kind: "file", path: "cache/result.json", ignored: true },
      { kind: "file", path: "keep.ts" },
    ] satisfies ReadonlyArray<ProjectEntry>);

    expect(tree[0]?.ignored).toBe(true);
    expect(tree[0]?.children[0]?.ignored).toBe(true);
    expect(tree[1]?.ignored).toBe(false);
  });
});
