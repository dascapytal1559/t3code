// Fork: checkpoint revert returns the prompt to the composer
// (FORK_FEATURES.md) — the mobile cache half. Thread snapshots cached before
// the revert-retention fix can hold ghost messages, so records written under
// schema v3 must be treated as misses and discarded.
import {
  EnvironmentId,
  type OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type ClientCacheKind, MobileDatabase } from "../persistence/mobile-database";
import { make } from "./environment-cache-store";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");

const snapshot: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  thread: {
    id: THREAD_ID,
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

function cacheId(environmentId: EnvironmentId, kind: ClientCacheKind, cacheKey: string) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const removed: Array<string> = [];
  const savedSchemaVersions: Array<number> = [];
  const database = MobileDatabase.of({
    loadCache: (environmentId, kind, cacheKey) =>
      Effect.succeed(Option.fromUndefinedOr(values.get(cacheId(environmentId, kind, cacheKey)))),
    saveCache: (environmentId, kind, cacheKey, schemaVersion, payload) =>
      Effect.sync(() => {
        savedSchemaVersions.push(schemaVersion);
        values.set(cacheId(environmentId, kind, cacheKey), payload);
      }),
    removeCache: (environmentId, kind, cacheKey) =>
      Effect.sync(() => {
        const id = cacheId(environmentId, kind, cacheKey);
        removed.push(id);
        values.delete(id);
      }),
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.succeed(Option.none()),
    savePreferencesJson: () => Effect.void,
  });
  return { database, removed, savedSchemaVersions, values };
}

describe("mobile thread snapshot cache (fork)", () => {
  it.effect("round-trips a thread snapshot under the current schema version", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));

      yield* store.saveThread(ENVIRONMENT_ID, snapshot);

      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(Option.some(snapshot));
      expect(memory.savedSchemaVersions).toEqual([4]);
    }),
  );

  it.effect("discards thread snapshots cached before the revert-retention fix", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const id = cacheId(ENVIRONMENT_ID, "thread", THREAD_ID);
      memory.values.set(
        id,
        JSON.stringify({
          schemaVersion: 3,
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
          snapshot,
        }),
      );

      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
    }),
  );
});
