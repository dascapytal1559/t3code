import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  AgentSessionThreadImportError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSource,
  type AgentSessionThreadImportInput,
  type AgentSessionThreadImportResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedErrorClass<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedErrorClass<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedErrorClass<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* importAgentSessionThread({
        projectId: input.projectId,
        workspaceRoot,
        thread,
        source: outcome.source,
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});

/**
 * Create the T3 thread for one transcript, install its resume cursor, and
 * record the imported history. Fails when the thread already carries local
 * activity that an import must not overwrite.
 */
const importAgentSessionThread = Effect.fn("importAgentSessionThread")(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly thread: AgentSessionScanner.AgentSessionThread;
  readonly source: AgentSessionImportSource;
}) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const { thread, workspaceRoot } = input;
  const threadId = ThreadId.make(`import:${thread.providerInstanceId}:${thread.providerSessionId}`);
  const provider = ProviderDriverKind.make(thread.source);
  const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  const existingThread = yield* snapshots.getThreadDetailById(threadId);
  const existingBinding = yield* directory.getBinding(threadId);

  if (
    thread.source === "claudeAgent" &&
    !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
  ) {
    return yield* new AgentSessionUnresumableSessionError({
      source: thread.source,
      providerSessionId: thread.providerSessionId,
    });
  }

  if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
    return yield* new AgentSessionThreadProjectConflictError({
      threadId,
      expectedProjectId: input.projectId,
      actualProjectId: existingThread.value.projectId,
    });
  }

  const importedHistoryPresent = Option.isSome(existingThread)
    ? hasImportedHistory(existingThread.value)
    : false;
  if (Option.isSome(existingThread) && importedHistoryPresent && Option.isSome(existingBinding)) {
    yield* directory.recordImportedTranscript({ threadId, source: input.source });
    return;
  }

  if (
    Option.isSome(existingThread) &&
    hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
  ) {
    return yield* new AgentSessionThreadModifiedError({ threadId });
  }

  if (
    Option.isSome(existingBinding) &&
    (existingBinding.value.provider !== provider ||
      existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
      existingBinding.value.status !== "stopped")
  ) {
    return yield* new AgentSessionThreadModifiedError({ threadId });
  }

  // Install the cursor before the thread becomes visible. A concurrent
  // real session can replace it, while insert-ignore keeps this import
  // from replacing that newer binding.
  if (Option.isNone(existingBinding)) {
    yield* directory.upsert(
      {
        threadId,
        provider,
        providerInstanceId: thread.providerInstanceId,
        status: "stopped",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: workspaceRoot },
      },
      { onConflict: "ignore" },
    );
  }

  if (Option.isNone(existingThread)) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      projectId: input.projectId,
      title: thread.title,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: thread.createdAt,
      historyImport: true,
    });
  }

  if (!importedHistoryPresent) {
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      messages: thread.messages.map((message, index) => ({
        messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    });
  }

  yield* directory.recordImportedTranscript({ threadId, source: input.source });
});

/**
 * Import one session named by its provider id. The transcript's working
 * directory decides the project: an active project rooted there is reused,
 * otherwise one is created. A session that was imported before opens as-is.
 */
export const importAgentThreadById = Effect.fn("importAgentThreadById")(function* (
  input: AgentSessionThreadImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const fail = (
    reason: AgentSessionThreadImportError["reason"],
    extra: { readonly path?: string; readonly detail?: string } = {},
  ) =>
    new AgentSessionThreadImportError({
      source: input.source,
      providerSessionId: input.providerSessionId,
      reason,
      ...extra,
    });

  const lookup = yield* scanner.findThread(input.source, input.providerSessionId);
  switch (lookup._tag) {
    case "NotFound":
      return yield* fail("not-found");
    case "Unreadable":
      return yield* fail("unreadable");
    case "MissingDirectory":
      return yield* fail("missing-directory", { path: lookup.workspaceRoot });
    case "ExcludedDirectory":
      return yield* fail("excluded-directory", { path: lookup.workspaceRoot });
    case "Found":
      break;
  }

  const { thread, workspaceRoot } = lookup;
  const threadId = ThreadId.make(`import:${thread.providerInstanceId}:${thread.providerSessionId}`);
  const existingThread = yield* snapshots
    .getThreadDetailById(threadId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  if (Option.isSome(existingThread)) {
    if (existingThread.value.deletedAt !== null) return yield* fail("thread-deleted");
    return {
      projectId: existingThread.value.projectId,
      threadId,
      projectCreated: false,
    } satisfies AgentSessionThreadImportResult;
  }

  const projectCreated = lookup.projectId === undefined;
  const projectId =
    lookup.projectId ??
    (yield* Effect.gen(function* () {
      const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        projectId,
        title: lookup.projectTitle,
        workspaceRoot,
        createWorkspaceRootIfMissing: false,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      return projectId;
    }).pipe(Effect.mapError((cause) => fail("import-failed", { detail: cause.message }))));

  yield* importAgentSessionThread({
    projectId,
    workspaceRoot,
    thread,
    source: lookup.source,
  }).pipe(Effect.mapError((cause) => fail("import-failed", { detail: cause.message })));

  return { projectId, threadId, projectCreated } satisfies AgentSessionThreadImportResult;
});
