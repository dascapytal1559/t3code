// Fork: checkpoint revert returns the prompt to the composer
// (FORK_FEATURES.md) — the cache half. Thread snapshots cached before the
// revert-retention fix can hold ghost messages, and the afterSequence resume
// would trust them forever, so the v4 bump must keep rejecting v3 records.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  EnvironmentId,
  type OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { decodeStoredThreadSnapshot } from "./storage";

const snapshot: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  thread: {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Test Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
};

const storedRecord = (schemaVersion: number) =>
  JSON.stringify({
    schemaVersion,
    environmentId: EnvironmentId.make("environment-1"),
    threadId: "thread-1",
    snapshot,
  });

describe("stored thread snapshot schema (fork)", () => {
  it.effect("decodes records written by the current client", () =>
    Effect.gen(function* () {
      const stored = yield* decodeStoredThreadSnapshot(storedRecord(4));
      expect(stored.snapshot).toEqual(snapshot);
    }),
  );

  it.effect("rejects records written before the revert-retention fix", () =>
    Effect.gen(function* () {
      const failure = yield* decodeStoredThreadSnapshot(storedRecord(3)).pipe(Effect.flip);
      expect(failure).toBeDefined();
    }),
  );
});
