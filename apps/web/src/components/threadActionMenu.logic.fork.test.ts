// Fork: Fork a thread (FORK_FEATURES.md) — the thread action menu half.
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  canFork: true,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true, fork: true },
  snoozePresets: [],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems fork item", () => {
  it("offers fork only when the server and provider support it", () => {
    expect(ids(baseState)).toContain("fork");
    expect(ids({ ...baseState, supports: { ...baseState.supports, fork: false } })).not.toContain(
      "fork",
    );
  });

  it("disables fork until the thread has a settled turn", () => {
    const forkItem = buildThreadActionMenuItems({ ...baseState, canFork: false }).find(
      (item) => item.id === "fork",
    );
    expect(forkItem?.disabled).toBe(true);
    const readyItem = buildThreadActionMenuItems(baseState).find((item) => item.id === "fork");
    expect(readyItem?.disabled).toBe(false);
  });
});
