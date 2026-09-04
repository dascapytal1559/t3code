// Fork: Fork a thread (FORK_FEATURES.md) — the command read model's copy of a
// forked thread's history.
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { forkedEntityId } from "./threadFork.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SOURCE = ThreadId.make("source");
const FORK = ThreadId.make("fork");

const message = (
  id: string,
  role: "user" | "assistant",
  turnId: string | null,
  at: string,
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role,
  text: `${role} ${id}`,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: at,
  updatedAt: at,
});

const checkpoint = (
  turnId: string,
  count: number,
  assistantMessageId: string,
): OrchestrationThread["checkpoints"][number] => ({
  turnId: TurnId.make(turnId),
  checkpointTurnCount: count,
  checkpointRef: checkpointRefForThreadTurn(SOURCE, count),
  status: "ready",
  files: [],
  assistantMessageId: MessageId.make(assistantMessageId),
  completedAt: NOW,
});

const activity = (
  id: string,
  turnId: string | null,
  sequence: number,
): OrchestrationThread["activities"][number] => ({
  id: EventId.make(id),
  tone: "tool",
  kind: "tool.completed",
  summary: id,
  payload: {},
  turnId: turnId === null ? null : TurnId.make(turnId),
  sequence,
  createdAt: NOW,
});

function sourceThread(): OrchestrationThread {
  return {
    id: SOURCE,
    projectId: ProjectId.make("project-1"),
    title: "Source",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      message("u1", "user", null, "2026-01-01T00:00:01.000Z"),
      message("a1", "assistant", "t1", "2026-01-01T00:00:02.000Z"),
      message("u2", "user", null, "2026-01-01T00:00:03.000Z"),
      message("a2", "assistant", "t2", "2026-01-01T00:00:04.000Z"),
      message("u3", "user", null, "2026-01-01T00:00:05.000Z"),
      message("a3", "assistant", "t3", "2026-01-01T00:00:06.000Z"),
    ],
    proposedPlans: [],
    activities: [activity("act-1", "t1", 1), activity("act-3", "t3", 3)],
    checkpoints: [checkpoint("t1", 1, "a1"), checkpoint("t2", 2, "a2"), checkpoint("t3", 3, "a3")],
    session: null,
  };
}

function forkEvent(turnId: string): OrchestrationEvent {
  return {
    sequence: 10,
    eventId: EventId.make("evt-fork"),
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: FORK,
    occurredAt: NOW,
    commandId: CommandId.make("cmd-fork"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: FORK,
      projectId: ProjectId.make("project-1"),
      title: "Source (fork)",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      forkedFrom: { threadId: SOURCE, turnId: TurnId.make(turnId) },
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

it.layer(NodeServices.layer)("projector thread fork", (it) => {
  it.effect("copies history through the fork turn under the fork's ids and refs", () =>
    Effect.gen(function* () {
      const model = { ...createEmptyReadModel(NOW), threads: [sourceThread()] };
      const next = yield* projectEvent(model, forkEvent("t2"));
      const fork = next.threads.find((thread) => thread.id === FORK);
      expect(fork).toBeDefined();
      expect(fork!.messages.map((entry) => entry.text)).toEqual([
        "user u1",
        "assistant a1",
        "user u2",
        "assistant a2",
      ]);
      expect(fork!.messages.map((entry) => entry.id)).toEqual(
        ["u1", "a1", "u2", "a2"].map((id) => forkedEntityId(FORK, id)),
      );
      expect(fork!.activities.map((entry) => entry.summary)).toEqual(["act-1"]);
      expect(fork!.checkpoints.map((entry) => entry.checkpointRef)).toEqual([
        checkpointRefForThreadTurn(FORK, 1),
        checkpointRefForThreadTurn(FORK, 2),
      ]);
      expect(fork!.checkpoints[1]?.assistantMessageId).toBe(forkedEntityId(FORK, "a2"));
      expect(fork!.latestTurn).toMatchObject({
        turnId: "t2",
        state: "completed",
        assistantMessageId: forkedEntityId(FORK, "a2"),
      });
      // The source is untouched.
      const source = next.threads.find((thread) => thread.id === SOURCE);
      expect(source?.messages).toHaveLength(6);
      expect(source?.checkpoints[0]?.checkpointRef).toBe(
        CheckpointRef.make(checkpointRefForThreadTurn(SOURCE, 1)),
      );
    }),
  );

  it.effect("creates an empty thread when the fork turn is unknown to the read model", () =>
    Effect.gen(function* () {
      const model = { ...createEmptyReadModel(NOW), threads: [sourceThread()] };
      const next = yield* projectEvent(model, forkEvent("t9"));
      const fork = next.threads.find((thread) => thread.id === FORK);
      expect(fork?.messages).toEqual([]);
      expect(fork?.latestTurn).toBeNull();
    }),
  );
});
