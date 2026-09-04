// Fork: Fork a thread (FORK_FEATURES.md) — the client-side gating rules.
import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkedThreadTitle,
  providerSupportsThreadFork,
  resolveThreadForkTurnId,
} from "./thread-fork.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const latestTurn = (state: "completed" | "running" | "error" | "interrupted") => ({
  turnId: TurnId.make("turn-3"),
  state,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: state === "running" ? null : NOW,
  assistantMessageId: null,
});

const session = (status: "running" | "ready", activeTurnId: string | null) => ({
  threadId: ThreadId.make("thread"),
  status,
  providerName: "codex",
  runtimeMode: "full-access" as const,
  activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
  lastError: null,
  updatedAt: NOW,
});

describe("providerSupportsThreadFork", () => {
  it("allows only the drivers whose adapters fork natively", () => {
    expect(providerSupportsThreadFork("codex")).toBe(true);
    expect(providerSupportsThreadFork("claudeAgent")).toBe(true);
    expect(providerSupportsThreadFork("opencode")).toBe(true);
    expect(providerSupportsThreadFork("cursor")).toBe(false);
    expect(providerSupportsThreadFork("grok")).toBe(false);
    expect(providerSupportsThreadFork(null)).toBe(false);
    expect(providerSupportsThreadFork(undefined)).toBe(false);
  });
});

describe("resolveThreadForkTurnId", () => {
  it("forks through the latest turn once it has settled", () => {
    expect(resolveThreadForkTurnId({ latestTurn: latestTurn("completed"), session: null })).toBe(
      "turn-3",
    );
    expect(
      resolveThreadForkTurnId({
        latestTurn: latestTurn("interrupted"),
        session: session("ready", null),
      }),
    ).toBe("turn-3");
  });

  it("offers nothing while a turn is running or before the first turn", () => {
    expect(
      resolveThreadForkTurnId({ latestTurn: latestTurn("running"), session: null }),
    ).toBeNull();
    expect(
      resolveThreadForkTurnId({
        latestTurn: latestTurn("completed"),
        session: session("running", "turn-4"),
      }),
    ).toBeNull();
    expect(resolveThreadForkTurnId({ latestTurn: null, session: null })).toBeNull();
  });
});

describe("forkedThreadTitle", () => {
  it("suffixes the source title and keeps long titles within bounds", () => {
    expect(forkedThreadTitle("Fix the parser")).toBe("Fix the parser (fork)");
    const long = forkedThreadTitle("x".repeat(200));
    expect(long.endsWith(" (fork)")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(120);
  });
});
