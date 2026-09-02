// Fork: checkpoint revert returns the prompt to the composer
// (FORK_FEATURES.md) — the retention half. Upstream's reducer kept every
// turn-less message after thread.reverted, leaving the reverted prompt in the
// timeline as a ghost the server no longer knows about.
import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

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

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null,
  at: string,
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: at,
  updatedAt: at,
});

const checkpoint = (
  turnId: string,
  checkpointTurnCount: number,
  assistantMessageId: string,
  completedAt: string,
): OrchestrationThread["checkpoints"][number] => ({
  turnId: TurnId.make(turnId),
  checkpointTurnCount,
  checkpointRef: CheckpointRef.make(`ref-${turnId}`),
  status: "ready",
  files: [],
  assistantMessageId: MessageId.make(assistantMessageId),
  completedAt,
});

const revertTo = (thread: OrchestrationThread, turnCount: number) =>
  applyThreadDetailEvent(thread, {
    ...baseEventFields,
    sequence: 14,
    occurredAt: "2026-04-01T05:00:00.000Z",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.reverted",
    payload: { threadId: ThreadId.make("thread-1"), turnCount },
  });

describe("applyThreadDetailEvent thread.reverted (fork)", () => {
  it("drops turn-less user prompts beyond the reverted turn count", () => {
    // Real user prompts are appended with turnId null (decider
    // thread.message-sent), so retention must cap them at the reverted turn
    // count like the server projector does, not keep them all.
    const thread: OrchestrationThread = {
      ...baseThread,
      messages: [
        message("msg-1", "user", "First prompt", null, "2026-04-01T01:00:00.000Z"),
        message("msg-2", "assistant", "Response 1", "turn-1", "2026-04-01T02:00:00.000Z"),
        message("msg-3", "user", "Second prompt", null, "2026-04-01T03:00:00.000Z"),
        message("msg-4", "assistant", "Response 2", "turn-2", "2026-04-01T04:00:00.000Z"),
      ],
      checkpoints: [
        checkpoint("turn-1", 1, "msg-2", "2026-04-01T02:00:00.000Z"),
        checkpoint("turn-2", 2, "msg-4", "2026-04-01T04:00:00.000Z"),
      ],
    };

    const result = revertTo(thread, 1);

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.messages.map((entry) => entry.id)).toEqual(["msg-1", "msg-2"]);
    }
  });

  it("drops the reverted prompt on a paginated window with high turn counts", () => {
    // thread.messages holds only a window of a long thread, so whole-thread
    // turn counts exceed the window's message count. The reverted prompt
    // must still be dropped: it postdates the last retained checkpoint.
    const thread: OrchestrationThread = {
      ...baseThread,
      messages: [
        message("msg-old", "user", "Prompt for turn 6", null, "2026-04-01T01:00:00.000Z"),
        message("msg-resp", "assistant", "Response 6", "turn-6", "2026-04-01T02:00:00.000Z"),
        message("msg-ghost", "user", "Reverted prompt", null, "2026-04-01T03:00:00.000Z"),
        message("msg-resp-7", "assistant", "Response 7", "turn-7", "2026-04-01T04:00:00.000Z"),
      ],
      checkpoints: [
        checkpoint("turn-6", 6, "msg-resp", "2026-04-01T02:00:00.000Z"),
        checkpoint("turn-7", 7, "msg-resp-7", "2026-04-01T04:00:00.000Z"),
      ],
    };

    const result = revertTo(thread, 6);

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.messages.map((entry) => entry.id)).toEqual(["msg-old", "msg-resp"]);
    }
  });
});
