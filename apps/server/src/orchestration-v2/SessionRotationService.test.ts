import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SessionRotationService from "./SessionRotationService.ts";

const NOW_MS = Date.parse("2026-11-18T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("thread:firstmate");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const driver = ProviderDriverKind.make("claudeAgent");

type Records = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "providerThreads" | "providerTurns" | "runtimeRequests" | "contextTransfers"
>;

function records({
  usedTokens = 250_000,
  cacheExpiresInMs = -MINUTE_MS,
}: { readonly usedTokens?: number; readonly cacheExpiresInMs?: number } = {}): Records {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "FirstMate",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      coordinator: true,
      createdAt: at(-120 * MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message-1"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-120 * MINUTE_MS),
        startedAt: at(-120 * MINUTE_MS),
        completedAt: at(-61 * MINUTE_MS),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "session-1", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-120 * MINUTE_MS),
        updatedAt: at(-61 * MINUTE_MS),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId: NodeId.make("root-node"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-120 * MINUTE_MS),
        completedAt: at(-61 * MINUTE_MS),
        tokenUsage: {
          usedTokens,
          promptCacheExpiresAt: DateTime.formatIso(at(cacheExpiresInMs)),
          updatedAt: DateTime.formatIso(at(-61 * MINUTE_MS)),
        },
      },
    ],
    runtimeRequests: [],
    contextTransfers: [],
  };
}

const RUN_ENDED = {
  id: EventId.make("run-ended"),
  type: "run.updated" as const,
  threadId,
  runId,
  occurredAt: at(),
  payload: records().runs[0]!,
};

/**
 * Starts the clock on `data`, either from a run that ended or from the start-up scan, and
 * returns the commands it dispatched once its one timer settles, after `advanceMs`.
 */
const runClock = (
  data: Records,
  { from, advanceMs = 0 }: { readonly from: "run" | "start"; readonly advanceMs?: number },
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const settled = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === "SessionRotationService.rotateWhenCold")
            Deferred.doneUnsafe(settled, Effect.void);
        };
        return span;
      },
    });
    const dispatched: Array<OrchestrationV2Command> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: from === "run" ? Stream.make(RUN_ENDED) : Stream.never,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as OrchestrationV2Command);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () => Effect.succeed(data.thread),
        getThreadRecords: () => Effect.succeed(data as never),
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 1,
            archivedThreads: [],
            threads:
              from === "start"
                ? [
                    {
                      id: threadId,
                      coordinator: data.thread.coordinator,
                      crewOf: data.thread.crewOf,
                      archivedAt: null,
                      deletedAt: null,
                    } as OrchestrationV2ThreadShell,
                  ]
                : [],
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* SessionRotationService.make;
      yield* service.start();
      if (advanceMs > 0) {
        yield* TestClock.adjust(advanceMs - 1);
        expect(dispatched).toEqual([]);
        yield* TestClock.adjust(1);
      }
      yield* Deferred.await(settled);
    }).pipe(Effect.provide(dependencies), Effect.withTracer(tracer));
    return dispatched;
  });

const ROTATION = {
  type: "thread.session.rotate",
  commandId: `server:session-rotation:${threadId}:${runId}`,
  threadId,
  reason: "cache_expired",
};

describe("SessionRotationService", () => {
  it.effect.each(["run", "start"] as const)(
    "rotates FirstMate's idle session once its cache has expired (from %s)",
    (from) =>
      Effect.gen(function* () {
        expect(yield* runClock(records(), { from })).toEqual([ROTATION]);
      }),
  );

  it.effect("waits for the cache to expire, then rotates", () =>
    Effect.gen(function* () {
      const warm = records({ cacheExpiresInMs: 10 * MINUTE_MS });
      expect(yield* runClock(warm, { from: "run", advanceMs: 10 * MINUTE_MS })).toEqual([ROTATION]);
    }),
  );

  const busy = (patch: Partial<Records>) => ({ ...records(), ...patch });
  it.effect.each<readonly [string, Records]>([
    ["a running turn", busy({ runs: [{ ...records().runs[0]!, status: "running" }] })],
    // A message queued behind the run that just ended, before it starts.
    [
      "a queued message",
      busy({
        runs: [
          ...records().runs,
          { ...records().runs[0]!, id: RunId.make("run-2"), ordinal: 2, status: "queued" },
        ],
      }),
    ],
    [
      "a pending question",
      busy({
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("request-1"),
            status: "pending",
          } as Records["runtimeRequests"][number],
        ],
      }),
    ],
    ["a fresh session under 100k", records({ usedTokens: 71_000 })],
    // The fresh session a rotation started, even past the floor, waits for the next real run.
    [
      "the session a rotation started",
      busy({
        runs: [
          {
            ...records().runs[0]!,
            userMessageId: MessageId.make(
              `message:session-rotation:server:session-rotation:${threadId}:run-0`,
            ),
          },
        ],
      }),
    ],
    ["a thread with no session yet", busy({ providerTurns: [] })],
    [
      "a thread that isn't a coordinator",
      busy({ thread: { ...records().thread, coordinator: false } }),
    ],
    [
      "a secondmate",
      busy({ thread: { ...records().thread, crewOf: ThreadId.make("thread:other") } }),
    ],
  ])("leaves the session alone on %s", ([, data]) =>
    Effect.gen(function* () {
      expect(yield* runClock(data, { from: "run" })).toEqual([]);
    }),
  );
});
