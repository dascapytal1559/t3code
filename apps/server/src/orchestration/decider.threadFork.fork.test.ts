// Fork: Fork a thread (FORK_FEATURES.md) — the decider's fork-point checks.
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("source"),
    projectId: ProjectId.make("project-1"),
    title: "Source",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-2"),
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
      {
        id: ProjectId.make("project-2"),
        title: "Other",
        workspaceRoot: "/tmp/other",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [thread],
    updatedAt: NOW,
  };
}

const forkCommand = (turnId: string, projectId = "project-1") => ({
  type: "thread.create" as const,
  commandId: CommandId.make("cmd-fork"),
  threadId: ThreadId.make("fork"),
  projectId: ProjectId.make(projectId),
  title: "Source (fork)",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  forkedFrom: { threadId: ThreadId.make("source"), turnId: TurnId.make(turnId) },
  createdAt: NOW,
});

it.layer(NodeServices.layer)("thread fork decider", (it) => {
  it.effect("emits thread.created carrying the fork source", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: forkCommand("turn-2"),
        readModel: makeReadModel(makeThread()),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.forkedFrom).toEqual({
          threadId: "source",
          turnId: "turn-2",
        });
      }
    }),
  );

  it.effect("rejects a fork through the turn that is still running", () =>
    Effect.gen(function* () {
      const running = makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const error = yield* decideOrchestrationCommand({
        command: forkCommand("turn-2"),
        readModel: makeReadModel(running),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      // Older, settled turns of the same thread still fork.
      const settledFork = yield* decideOrchestrationCommand({
        command: forkCommand("turn-1"),
        readModel: makeReadModel(running),
      });
      expect((Array.isArray(settledFork) ? settledFork : [settledFork])[0]?.type).toBe(
        "thread.created",
      );
    }),
  );

  it.effect("rejects forks into another project and from unknown sources", () =>
    Effect.gen(function* () {
      const otherProject = yield* decideOrchestrationCommand({
        command: forkCommand("turn-2", "project-2"),
        readModel: makeReadModel(makeThread()),
      }).pipe(Effect.flip);
      expect(otherProject._tag).toBe("OrchestrationCommandInvariantError");

      const missingSource = yield* decideOrchestrationCommand({
        command: forkCommand("turn-2"),
        readModel: makeReadModel(makeThread({ id: ThreadId.make("someone-else") })),
      }).pipe(Effect.flip);
      expect(missingSource._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
