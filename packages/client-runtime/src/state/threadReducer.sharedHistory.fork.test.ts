// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
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
};

describe("thread.message-sent with shared history import", () => {
  it("places refreshed native history before newer local messages without changing checkpoint state", () => {
    const local = {
      id: MessageId.make("local"),
      role: "user" as const,
      text: "Continue",
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T06:00:00.000Z",
      updatedAt: "2026-04-01T06:00:00.000Z",
    };
    const thread = { ...baseThread, messages: [local] };
    const result = applyThreadDetailEvent(thread, {
      ...baseEventFields,
      metadata: { historyImport: true },
      sequence: 2,
      occurredAt: "2026-04-01T05:00:00.000Z",
      aggregateKind: "thread",
      aggregateId: thread.id,
      type: "thread.message-sent",
      payload: {
        threadId: thread.id,
        messageId: MessageId.make("codex-shared:item"),
        role: "assistant",
        text: "Desktop answer",
        turnId: TurnId.make("native-turn"),
        streaming: false,
        createdAt: "2026-04-01T05:00:00.000Z",
        updatedAt: "2026-04-01T05:00:00.000Z",
      },
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.thread.messages.map((message) => message.text)).toEqual([
      "Desktop answer",
      "Continue",
    ]);
    expect(result.thread.messages[1]).toBe(local);
    expect(result.thread.latestTurn).toBe(thread.latestTurn);
    expect(result.thread.checkpoints).toBe(thread.checkpoints);
  });
});
