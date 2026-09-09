// Fork: import a Codex or Claude session by id (FORK_FEATURES.md). Covers
// `importAgentThreadById`: project resolution or creation, reuse of an
// existing imported thread, and the user-facing failure reasons.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentSessionThreadImportError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { importAgentThreadById } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CODEX_THREAD_ID = "01a07bb0-b316-7bd2-8074-aacf1e1d1422";
const WORKSPACE_ROOT = "/tmp/project-from-transcript";
const EXISTING_PROJECT_ID = ProjectId.make("project-existing");
const IMPORTED_THREAD_ID = ThreadId.make(`import:codex:${CODEX_THREAD_ID}`);

const codexThread: AgentSessionScanner.AgentSessionThread = {
  source: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: CODEX_THREAD_ID,
  title: "Imported Codex thread",
  model: null,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  messages: [
    { role: "user", text: "Fix the bug", createdAt: "2026-08-24T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-08-24T10:01:00.000Z" },
  ],
};

const found = (projectId: ProjectId | undefined): AgentSessionScanner.AgentSessionThreadLookup => ({
  _tag: "Found",
  thread: codexThread,
  source: {
    provider: "codex",
    providerInstanceId: codexThread.providerInstanceId,
    providerSessionId: CODEX_THREAD_ID,
    filePath: `/tmp/sessions/rollout-${CODEX_THREAD_ID}.jsonl`,
    size: 0,
    mtimeMs: 0,
    device: 0,
    inode: 0,
    birthtimeMs: 0,
  },
  workspaceRoot: WORKSPACE_ROOT,
  projectId,
  projectTitle: "project-from-transcript",
});

const makeScanner = (lookup: AgentSessionScanner.AgentSessionThreadLookup) =>
  AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () => Stream.empty,
    findThread: () => Effect.succeed(lookup),
  });

const makeExistingThread = (deletedAt: string | null): OrchestrationThread => ({
  id: IMPORTED_THREAD_ID,
  projectId: EXISTING_PROJECT_ID,
  title: codexThread.title,
  modelSelection: { instanceId: codexThread.providerInstanceId, model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: codexThread.createdAt,
  updatedAt: codexThread.updatedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt,
  messages: [
    {
      id: MessageId.make(`${IMPORTED_THREAD_ID}:000000`),
      role: "user",
      text: "Fix the bug",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const runImport = (input: {
  readonly lookup: AgentSessionScanner.AgentSessionThreadLookup;
  readonly existingThread?: OrchestrationThread;
}) =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
    const result = yield* importAgentThreadById({
      source: "codex",
      providerSessionId: CODEX_THREAD_ID,
    }).pipe(
      Effect.provideService(AgentSessionScanner.AgentSessionScanner, makeScanner(input.lookup)),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
          }),
          Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
            upsert: (binding) => Effect.sync(() => void bindings.push(binding)),
            recordImportedTranscript: () => Effect.void,
            getBinding: () => Effect.succeed(Option.none()),
          }),
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getThreadDetailById: () =>
              Effect.succeed(
                input.existingThread === undefined
                  ? Option.none()
                  : Option.some(input.existingThread),
              ),
          }),
        ),
      ),
      Effect.result,
    );
    return { result, commands, bindings };
  });

it.layer(NodeServices.layer)("importAgentThreadById (fork)", (it) => {
  describe("project resolution", () => {
    it.effect("creates a project at the transcript's cwd when none exists", () =>
      Effect.gen(function* () {
        const { result, commands, bindings } = yield* runImport({ lookup: found(undefined) });

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(result.success.threadId).toBe(IMPORTED_THREAD_ID);
        expect(result.success.projectCreated).toBe(true);
        expect(commands.map((command) => command.type)).toEqual([
          "project.create",
          "thread.create",
          "thread.history.import",
        ]);
        expect(commands[0]).toMatchObject({
          type: "project.create",
          projectId: result.success.projectId,
          title: "project-from-transcript",
          workspaceRoot: WORKSPACE_ROOT,
          createWorkspaceRootIfMissing: false,
        });
        expect(commands[1]).toMatchObject({
          type: "thread.create",
          threadId: IMPORTED_THREAD_ID,
          projectId: result.success.projectId,
          historyImport: true,
        });
        expect(bindings).toMatchObject([
          {
            threadId: IMPORTED_THREAD_ID,
            provider: "codex",
            resumeCursor: { threadId: CODEX_THREAD_ID },
            runtimePayload: { cwd: WORKSPACE_ROOT },
          },
        ]);
      }),
    );

    it.effect("reuses the active project rooted at the transcript's cwd", () =>
      Effect.gen(function* () {
        const { result, commands } = yield* runImport({ lookup: found(EXISTING_PROJECT_ID) });

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(result.success).toEqual({
          projectId: EXISTING_PROJECT_ID,
          threadId: IMPORTED_THREAD_ID,
          projectCreated: false,
        });
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.history.import",
        ]);
      }),
    );
  });

  describe("existing threads", () => {
    it.effect("opens a thread that was imported before without touching it", () =>
      Effect.gen(function* () {
        const { result, commands, bindings } = yield* runImport({
          lookup: found(undefined),
          existingThread: makeExistingThread(null),
        });

        expect(result).toMatchObject({
          _tag: "Success",
          success: {
            projectId: EXISTING_PROJECT_ID,
            threadId: IMPORTED_THREAD_ID,
            projectCreated: false,
          },
        });
        expect(commands).toEqual([]);
        expect(bindings).toEqual([]);
      }),
    );

    it.effect("refuses to re-import a deleted thread", () =>
      Effect.gen(function* () {
        const { result, commands } = yield* runImport({
          lookup: found(undefined),
          existingThread: makeExistingThread("2026-08-25T00:00:00.000Z"),
        });

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AgentSessionThreadImportError", reason: "thread-deleted" },
        });
        expect(commands).toEqual([]);
      }),
    );
  });

  describe("lookup failures", () => {
    it.effect.each([
      [{ _tag: "NotFound" }, "not-found", undefined],
      [{ _tag: "Unreadable" }, "unreadable", undefined],
      [{ _tag: "MissingDirectory", workspaceRoot: "/gone" }, "missing-directory", "/gone"],
      [{ _tag: "ExcludedDirectory", workspaceRoot: "/tmp" }, "excluded-directory", "/tmp"],
    ] as const)("maps %o to a typed error", ([lookup, reason, path]) =>
      Effect.gen(function* () {
        const { result, commands } = yield* runImport({ lookup });

        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure).toBeInstanceOf(AgentSessionThreadImportError);
        expect(result.failure).toMatchObject({
          reason,
          source: "codex",
          providerSessionId: CODEX_THREAD_ID,
          ...(path === undefined ? {} : { path }),
        });
        expect(result.failure.message).toContain(CODEX_THREAD_ID);
        expect(commands).toEqual([]);
      }),
    );
  });
});
