import { assert, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import { notifyCoordinators } from "./CoordinatorRestartNote.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");
const coordinatorId = ThreadId.make("thread:coordinator");
const serverStartedAt = DateTime.makeUnsafe("2026-10-03T12:30:00.000Z");
const startedAt = DateTime.formatIso(serverStartedAt);

function shellThread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("restart-project"),
    title: id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    status: "completed",
    activeRunId: null,
    latestRunStartedAt: now,
    latestRunStopRequested: false,
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    settledOverride: null,
    ...overrides,
  };
}

function crewThread(id: string, overrides: Record<string, unknown> = {}) {
  return shellThread(id, { crewOf: coordinatorId, ...overrides });
}

const restartNotes = Effect.fn(function* (
  shells: ReadonlyArray<ReturnType<typeof shellThread>>,
  {
    passes = 1,
    enabled = true,
    resuming = [],
  }: {
    readonly passes?: number;
    readonly enabled?: boolean;
    /** Threads whose last run has a restart continuation waiting in the outbox. */
    readonly resuming?: ReadonlyArray<string>;
  } = {},
) {
  const commands: Parameters<
    ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
  >[0][] = [];
  const layer = Layer.merge(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      serverStartedAt: Effect.succeed(serverStartedAt),
      getShellSnapshot: () => Effect.succeed({ threads: shells } as never),
      getThreadRecords: (threadId) =>
        Effect.succeed({
          runs: [
            {
              id: RunId.make(`run:${threadId}`),
              ordinal: 1,
              status: "cancelled",
              startedAt: now,
              completedAt: now,
            },
          ],
          messages: commands.flatMap((command) =>
            command.type === "message.dispatch" ? [{ id: command.messageId }] : [],
          ),
        } as never),
      restartContinuationPending: (run) =>
        Effect.succeed(resuming.some((threadId) => run.id === `run:${threadId}`)),
      dispatch: (command) => {
        commands.push(command);
        return Effect.succeed({} as never);
      },
    }),
    ServerSettings.layerTest({ continueThreadsAfterServerUpdate: enabled }),
  );
  for (let pass = 0; pass < passes; pass += 1)
    yield* notifyCoordinators().pipe(Effect.provide(layer));
  return commands;
});

it.effect.each([false, true])(
  "tells an idle coordinator (pinned: %s) once per server start which crew the restart cut",
  (coordinator) =>
    Effect.gen(function* () {
      const commands = yield* restartNotes(
        [
          shellThread("thread:coordinator", { coordinator }),
          crewThread("thread:crew-cut", { status: "cancelled" }),
          crewThread("thread:crew-done"),
          crewThread("thread:crew-stopped", { status: "cancelled", latestRunStopRequested: true }),
        ],
        { passes: 2 },
      );
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.equal(command.threadId, coordinatorId);
      assert.equal(command.commandId, `command:restart-note:${coordinatorId}:${startedAt}`);
      // FirstMate matches this line against t3_restart_status's serverStartedAt.
      assert.isTrue(command.text.startsWith(`The T3 server restarted at ${startedAt}.\n`));
      assert.include(command.text, "- thread:crew-cut (thread:crew-cut)");
      assert.notInclude(command.text, "thread:crew-done");
      assert.notInclude(command.text, "thread:crew-stopped");
    }),
);

it.effect.each([
  ["has no crew", [shellThread("thread:coordinator", { coordinator: true })]],
  [
    "is busy and its crew ran clean",
    [
      shellThread("thread:coordinator", {
        coordinator: true,
        status: "running",
        activeRunId: RunId.make("run:active"),
      }),
      crewThread("thread:crew"),
    ],
  ],
  [
    "had its own run cut, which T3 is not resuming",
    [shellThread("thread:coordinator", { coordinator: true, status: "cancelled" })],
  ],
] as const)("tells a pinned coordinator that %s about the restart once", ([, shells]) =>
  Effect.gen(function* () {
    const commands = yield* restartNotes(shells, { passes: 2 });
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    if (command.type !== "message.dispatch") return assert.fail(command.type);
    assert.equal(command.threadId, coordinatorId);
    assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
    assert.include(command.text, "None of your crew threads had a run interrupted.");
  }),
);

it.effect("tells an unpinned coordinator whose own cut run T3 is not resuming", () =>
  Effect.gen(function* () {
    const commands = yield* restartNotes([
      shellThread("thread:coordinator", { status: "cancelled" }),
      crewThread("thread:crew"),
    ]);
    assert.deepEqual(
      commands.flatMap((command) =>
        command.type === "message.dispatch" ? [command.threadId] : [],
      ),
      [coordinatorId],
    );
  }),
);

it.effect.each([
  ["idle", "completed", [coordinatorId]],
  ["cut", "cancelled", [ThreadId.make("thread:old"), coordinatorId]],
] as const)(
  "beside a pinned coordinator, wakes an older parent whose crew is %s only when the restart cut it",
  ([, crewStatus, expected]) =>
    Effect.gen(function* () {
      const commands = yield* restartNotes([
        shellThread("thread:old"),
        shellThread("thread:coordinator", { coordinator: true }),
        shellThread("thread:old-crew", {
          crewOf: ThreadId.make("thread:old"),
          status: crewStatus,
        }),
      ]);
      assert.deepEqual(
        commands.flatMap((command) =>
          command.type === "message.dispatch" ? [command.threadId] : [],
        ),
        [...expected],
      );
    }),
);

it.effect.each([
  ["it has no crew", [shellThread("thread:coordinator")], {}],
  [
    "it is archived",
    [shellThread("thread:coordinator", { archivedAt: now }), crewThread("thread:crew")],
    {},
  ],
  [
    "its only crew is archived",
    [shellThread("thread:coordinator"), crewThread("thread:crew", { archivedAt: now })],
    {},
  ],
  [
    "it is snoozed",
    [
      shellThread("thread:coordinator", {
        snoozedUntil: DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"),
      }),
      crewThread("thread:crew"),
    ],
    {},
  ],
  [
    "it is settled, even with a cut crew run",
    [
      shellThread("thread:coordinator", { settledOverride: "settled" }),
      crewThread("thread:crew", { status: "cancelled" }),
    ],
    {},
  ],
  [
    "it is pinned but settled",
    [shellThread("thread:coordinator", { coordinator: true, settledOverride: "settled" })],
    {},
  ],
  [
    "T3 is resuming its own cut run",
    [shellThread("thread:coordinator", { status: "cancelled" }), crewThread("thread:crew")],
    { resuming: ["thread:coordinator"] },
  ],
  [
    "it is pinned and T3 is resuming its own cut run, which carries the note",
    [shellThread("thread:coordinator", { coordinator: true, status: "cancelled" })],
    { resuming: ["thread:coordinator"] },
  ],
  [
    "it is pinned but the project opted out",
    [shellThread("thread:coordinator", { coordinator: true })],
    { enabled: false },
  ],
  [
    "it has a run waiting to start",
    [shellThread("thread:coordinator", { status: "queued" }), crewThread("thread:crew")],
    {},
  ],
  [
    "the project opted out",
    [shellThread("thread:coordinator"), crewThread("thread:crew")],
    { enabled: false },
  ],
] as const)("sends no restart note when %s", ([, shells, options]) =>
  Effect.gen(function* () {
    assert.lengthOf(yield* restartNotes(shells, options), 0);
  }),
);
