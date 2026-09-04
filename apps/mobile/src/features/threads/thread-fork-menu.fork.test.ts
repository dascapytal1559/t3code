// Fork: Fork a thread (FORK_FEATURES.md) — the mobile row menu item.
import { describe, expect, it } from "vite-plus/test";

import { buildThreadForkMenuItems } from "./thread-fork-menu";

describe("buildThreadForkMenuItems", () => {
  it("hides the item when the server or provider cannot fork", () => {
    expect(buildThreadForkMenuItems({ supported: false, canFork: true })).toEqual([]);
  });

  it("offers the item and disables it until a turn has settled", () => {
    expect(buildThreadForkMenuItems({ supported: true, canFork: true })).toEqual([
      { id: "fork", title: "Fork thread", image: "arrow.triangle.branch" },
    ]);
    expect(buildThreadForkMenuItems({ supported: true, canFork: false })[0]).toMatchObject({
      id: "fork",
      attributes: { disabled: true },
    });
  });
});
