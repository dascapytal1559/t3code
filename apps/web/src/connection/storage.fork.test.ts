// Fork: checkpoint revert returns the prompt to the composer
// (FORK_FEATURES.md) — the cache half. Thread snapshots cached before the
// revert-retention fix can hold ghost messages, and the afterSequence resume
// would trust them forever. The fork bumped to v4 for that; upstream later
// bumped its own schema to v4 for thinking traces, so the fork sits at v5 and
// must keep rejecting every older record.
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
    pullRequests: [],
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
      const stored = yield* decodeStoredThreadSnapshot(storedRecord(5));
      expect(stored.snapshot).toEqual(snapshot);
    }),
  );

  it.effect.each([3, 4])("rejects records written under schema v%s", (schemaVersion) =>
    Effect.gen(function* () {
      const failure = yield* decodeStoredThreadSnapshot(storedRecord(schemaVersion)).pipe(
        Effect.flip,
      );
      expect(failure).toBeDefined();
    }),
  );
});
