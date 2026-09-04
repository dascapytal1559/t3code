// Fork: Fork a thread (FORK_FEATURES.md) — every SQL projector copies the
// source thread's rows through the fork turn under the fork's ids.
import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { forkedEntityId } from "../threadFork.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-fork-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const SOURCE = ThreadId.make("source");
const FORK = ThreadId.make("fork");
const PROJECT = ProjectId.make("project-fork");

type EventInput = Parameters<OrchestrationEventStore["Service"]["append"]>[0];

let sequence = 0;
function event<T extends OrchestrationEvent["type"]>(
  type: T,
  occurredAt: string,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
): EventInput {
  sequence += 1;
  return {
    type,
    eventId: EventId.make(`evt-fork-${sequence}`),
    aggregateKind: type.startsWith("project.") ? "project" : "thread",
    aggregateId: type.startsWith("project.")
      ? PROJECT
      : ((payload as { readonly threadId: ThreadId }).threadId ?? SOURCE),
    occurredAt,
    commandId: CommandId.make(`cmd-fork-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-fork-${sequence}`),
    metadata: {},
    payload,
  } as EventInput;
}

const at = (seconds: number) => `2026-03-01T12:00:${String(seconds).padStart(2, "0")}.000Z`;

const threadCreated = (threadId: ThreadId, forkedFrom?: { threadId: ThreadId; turnId: TurnId }) =>
  event("thread.created", at(1), {
    threadId,
    projectId: PROJECT,
    title: threadId === FORK ? "Source (fork)" : "Source",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    ...(forkedFrom ? { forkedFrom } : {}),
    createdAt: at(1),
    updatedAt: at(1),
  });

const message = (
  messageId: string,
  role: "user" | "assistant",
  turnId: string | null,
  seconds: number,
) =>
  event("thread.message-sent", at(seconds), {
    threadId: SOURCE,
    messageId: MessageId.make(messageId),
    role,
    text: `${role} ${messageId}`,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming: false,
    createdAt: at(seconds),
    updatedAt: at(seconds),
  });

const turnCompleted = (
  turnId: string,
  count: number,
  assistantMessageId: string,
  seconds: number,
) =>
  event("thread.turn-diff-completed", at(seconds), {
    threadId: SOURCE,
    turnId: TurnId.make(turnId),
    checkpointTurnCount: count,
    checkpointRef: checkpointRefForThreadTurn(SOURCE, count),
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(assistantMessageId),
    completedAt: at(seconds),
  });

const activity = (activityId: string, turnId: string, seconds: number) =>
  event("thread.activity-appended", at(seconds), {
    threadId: SOURCE,
    activity: {
      id: EventId.make(activityId),
      tone: "tool",
      kind: "tool.completed",
      summary: activityId,
      payload: { activityId },
      turnId: TurnId.make(turnId),
      createdAt: at(seconds),
    },
  });

it.layer(TestLayer)("OrchestrationProjectionPipeline thread fork", (it) => {
  it.effect("copies messages, activities, turns and the shell summary through the fork turn", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (input: EventInput) =>
        eventStore
          .append(input)
          .pipe(Effect.flatMap((saved) => projectionPipeline.projectEvent(saved)));

      yield* appendAndProject(
        event("project.created", at(0), {
          projectId: PROJECT,
          title: "Project",
          workspaceRoot: "/tmp/project-fork",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        }),
      );
      yield* appendAndProject(threadCreated(SOURCE));
      // Three turns: user prompt (turnless), assistant reply, checkpoint.
      yield* appendAndProject(message("u1", "user", null, 2));
      yield* appendAndProject(message("a1", "assistant", "t1", 3));
      yield* appendAndProject(turnCompleted("t1", 1, "a1", 4));
      yield* appendAndProject(activity("act-1", "t1", 4));
      yield* appendAndProject(message("u2", "user", null, 5));
      yield* appendAndProject(message("a2", "assistant", "t2", 6));
      yield* appendAndProject(turnCompleted("t2", 2, "a2", 7));
      yield* appendAndProject(activity("act-2", "t2", 7));
      yield* appendAndProject(message("u3", "user", null, 8));
      yield* appendAndProject(message("a3", "assistant", "t3", 9));
      yield* appendAndProject(turnCompleted("t3", 3, "a3", 10));
      yield* appendAndProject(activity("act-3", "t3", 10));

      yield* appendAndProject(threadCreated(FORK, { threadId: SOURCE, turnId: TurnId.make("t2") }));

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
        readonly turnId: string | null;
      }>`
        SELECT message_id AS "messageId", text, turn_id AS "turnId"
        FROM projection_thread_messages
        WHERE thread_id = ${FORK}
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        { messageId: forkedEntityId(FORK, "u1"), text: "user u1", turnId: null },
        { messageId: forkedEntityId(FORK, "a1"), text: "assistant a1", turnId: "t1" },
        { messageId: forkedEntityId(FORK, "u2"), text: "user u2", turnId: null },
        { messageId: forkedEntityId(FORK, "a2"), text: "assistant a2", turnId: "t2" },
      ]);

      const activityRows = yield* sql<{ readonly activityId: string; readonly summary: string }>`
        SELECT activity_id AS "activityId", summary
        FROM projection_thread_activities
        WHERE thread_id = ${FORK}
        ORDER BY created_at ASC
      `;
      assert.deepEqual(activityRows, [
        { activityId: forkedEntityId(FORK, "act-1"), summary: "act-1" },
        { activityId: forkedEntityId(FORK, "act-2"), summary: "act-2" },
      ]);

      const turnRows = yield* sql<{
        readonly turnId: string;
        readonly checkpointRef: string;
        readonly assistantMessageId: string;
        readonly state: string;
      }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_ref AS "checkpointRef",
          assistant_message_id AS "assistantMessageId",
          state
        FROM projection_turns
        WHERE thread_id = ${FORK}
        ORDER BY checkpoint_turn_count ASC
      `;
      assert.deepEqual(turnRows, [
        {
          turnId: "t1",
          checkpointRef: checkpointRefForThreadTurn(FORK, 1),
          assistantMessageId: forkedEntityId(FORK, "a1"),
          state: "completed",
        },
        {
          turnId: "t2",
          checkpointRef: checkpointRefForThreadTurn(FORK, 2),
          assistantMessageId: forkedEntityId(FORK, "a2"),
          state: "completed",
        },
      ]);

      const threadRows = yield* sql<{
        readonly latestTurnId: string | null;
        readonly latestUserMessageAt: string | null;
      }>`
        SELECT latest_turn_id AS "latestTurnId", latest_user_message_at AS "latestUserMessageAt"
        FROM projection_threads
        WHERE thread_id = ${FORK}
      `;
      assert.deepEqual(threadRows, [{ latestTurnId: "t2", latestUserMessageAt: at(5) }]);

      // The source keeps everything.
      const sourceCounts = yield* sql<{ readonly messages: number; readonly turns: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${SOURCE}) AS messages,
          (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${SOURCE}) AS turns
      `;
      assert.deepEqual(sourceCounts, [{ messages: 6, turns: 3 }]);
      assert.equal(CheckpointRef.make(checkpointRefForThreadTurn(SOURCE, 3)).length > 0, true);
    }),
  );
});
