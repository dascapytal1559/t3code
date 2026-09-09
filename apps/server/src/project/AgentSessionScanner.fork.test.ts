// Fork: import a Codex or Claude session by id (FORK_FEATURES.md). Covers
// `findThread`, the by-id transcript lookup the palette's paste action uses.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CODEX_THREAD_ID = "01a07bb0-b316-7bd2-8074-aacf1e1d1422";
const CLAUDE_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_ID = ProjectId.make("project-1");

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Persisted title",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeProjectionSnapshotQueryLayer = (importedWorkspaceRoots: ReadonlyArray<string>) =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: importedWorkspaceRoots.map((workspaceRoot) => makeProjectShell(workspaceRoot)),
        threads: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    getImportedAgentSessionSources: () => Effect.succeed([]),
  });

interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly importedWorkspaceRoots?: ReadonlyArray<string>;
}

const makeScannerTestLayer = (input: ScannerTestInput) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providers: {
            claudeAgent: { homePath: input.claudeHomePath },
            codex: { homePath: input.codexHomePath },
          },
        }),
        ServerConfig.layerTest(input.claudeHomePath, { prefix: "t3code-scanner-fork-config-" }),
        makeProjectionSnapshotQueryLayer(input.importedWorkspaceRoots ?? []),
      ),
    ),
  );

const findThread = (
  input: ScannerTestInput & {
    readonly source: "claudeAgent" | "codex";
    readonly providerSessionId: string;
  },
) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.findThread(input.source, input.providerSessionId);
  }).pipe(Effect.provide(makeScannerTestLayer(input)));

const makeTempDir = Effect.fn("AgentSessionScanner.fork.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScanner.fork.test.writeTranscript")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    readonly mtimeMs: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fileSystem.writeFileString(input.filePath, input.contents);
    const seconds = input.mtimeMs / 1000;
    yield* fileSystem.utimes(input.filePath, seconds, seconds);
  },
);

const codexTranscript = (input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompt: string;
}) =>
  [
    encodeTranscriptRecord({
      type: "session_meta",
      payload: { id: input.sessionId, cwd: input.cwd },
    }),
    encodeTranscriptRecord({
      type: "event_msg",
      timestamp: "2026-08-24T10:00:00.000Z",
      payload: { type: "user_message", message: input.prompt },
    }),
    encodeTranscriptRecord({
      type: "response_item",
      timestamp: "2026-08-24T10:01:00.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      },
    }),
  ].join("\n");

const claudeTranscript = (input: { readonly sessionId: string; readonly cwd: string }) =>
  [
    encodeTranscriptRecord({
      type: "user",
      cwd: input.cwd,
      sessionId: input.sessionId,
      timestamp: "2026-08-24T10:00:00.000Z",
      message: { role: "user", content: "Fix the bug" },
    }),
    encodeTranscriptRecord({
      type: "assistant",
      timestamp: "2026-08-24T10:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Fixed" }] },
    }),
  ].join("\n");

it.layer(NodeServices.layer)("AgentSessionScanner.findThread (fork)", (it) => {
  describe("codex", () => {
    it.effect("reads the newest continuation file naming the thread, with no age window", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const sessions = path.join(codexHomePath, "sessions");

        // Two years old: recentThreads would skip it, findThread must not.
        yield* writeTranscript({
          filePath: path.join(
            sessions,
            "2024",
            "09",
            "07",
            `rollout-2024-09-07T21-46-12-${CODEX_THREAD_ID}.jsonl`,
          ),
          contents: codexTranscript({
            sessionId: CODEX_THREAD_ID,
            cwd: workspace,
            prompt: "First",
          }),
          mtimeMs: Date.parse("2024-09-07T21:46:12.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(
            sessions,
            "2024",
            "09",
            "08",
            `rollout-2024-09-08T17-47-02-${CODEX_THREAD_ID}_01a07ffc-1814-70c0-8d1f-6b3c4a6f5432.jsonl`,
          ),
          contents: codexTranscript({
            sessionId: CODEX_THREAD_ID,
            cwd: workspace,
            prompt: "Latest",
          }),
          mtimeMs: Date.parse("2024-09-08T17:47:02.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(
            sessions,
            "2024",
            "09",
            "08",
            "rollout-2024-09-08T18-00-00-other.jsonl",
          ),
          contents: codexTranscript({ sessionId: "other", cwd: workspace, prompt: "Unrelated" }),
          mtimeMs: Date.parse("2024-09-08T18:00:00.000Z"),
        });

        const lookup = yield* findThread({
          claudeHomePath,
          codexHomePath,
          source: "codex",
          providerSessionId: CODEX_THREAD_ID,
        });

        expect(lookup._tag).toBe("Found");
        if (lookup._tag !== "Found") return;
        expect(lookup.thread.providerSessionId).toBe(CODEX_THREAD_ID);
        expect(lookup.thread.messages.map((message) => message.text)).toEqual(["Latest", "Done"]);
        expect(lookup.source.filePath).toContain("_01a07ffc");
        expect(lookup.workspaceRoot).toBe(workspace);
        expect(lookup.projectId).toBeUndefined();
        expect(lookup.projectTitle).toBe(path.basename(workspace));
      }),
    );

    it.effect("reports a persisted project rooted at the transcript's cwd", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "09",
            "07",
            `rollout-2026-09-07T21-46-12-${CODEX_THREAD_ID}.jsonl`,
          ),
          contents: codexTranscript({ sessionId: CODEX_THREAD_ID, cwd: workspace, prompt: "Hi" }),
          mtimeMs: Date.parse("2026-09-07T21:46:12.000Z"),
        });

        const lookup = yield* findThread({
          claudeHomePath,
          codexHomePath,
          importedWorkspaceRoots: [`${workspace}/`],
          source: "codex",
          providerSessionId: CODEX_THREAD_ID.toUpperCase(),
        });

        expect(lookup).toMatchObject({
          _tag: "Found",
          projectId: PROJECT_ID,
          projectTitle: "Persisted title",
          workspaceRoot: `${workspace}/`,
        });
      }),
    );

    it.effect("distinguishes a missing session from an unreadable one", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        expect(
          yield* findThread({
            claudeHomePath,
            codexHomePath,
            source: "codex",
            providerSessionId: CODEX_THREAD_ID,
          }),
        ).toEqual({ _tag: "NotFound" });

        // The file name carries the id but its metadata names another session.
        yield* writeTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "09",
            "07",
            `rollout-2026-09-07T21-46-12-${CODEX_THREAD_ID}.jsonl`,
          ),
          contents: codexTranscript({ sessionId: "renamed", cwd: workspace, prompt: "Hi" }),
          mtimeMs: Date.parse("2026-09-07T21:46:12.000Z"),
        });

        expect(
          yield* findThread({
            claudeHomePath,
            codexHomePath,
            source: "codex",
            providerSessionId: CODEX_THREAD_ID,
          }),
        ).toEqual({ _tag: "Unreadable" });
      }),
    );

    it.effect("rejects directories that no longer exist or cannot be projects", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const missingWorkspace = path.join(yield* makeTempDir("t3code-workspace-"), "gone");
        const rollout = (day: string, id: string) =>
          path.join(
            codexHomePath,
            "sessions",
            "2026",
            "09",
            day,
            `rollout-2026-09-${day}T10-00-00-${id}.jsonl`,
          );
        const missingId = "01a07bb0-b316-7bd2-8074-000000000001";
        const excludedId = "01a07bb0-b316-7bd2-8074-000000000002";

        yield* writeTranscript({
          filePath: rollout("01", missingId),
          contents: codexTranscript({ sessionId: missingId, cwd: missingWorkspace, prompt: "Hi" }),
          mtimeMs: Date.parse("2026-09-01T10:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: rollout("02", excludedId),
          contents: codexTranscript({ sessionId: excludedId, cwd: NodeOS.homedir(), prompt: "Hi" }),
          mtimeMs: Date.parse("2026-09-02T10:00:00.000Z"),
        });

        expect(
          yield* findThread({
            claudeHomePath,
            codexHomePath,
            source: "codex",
            providerSessionId: missingId,
          }),
        ).toEqual({ _tag: "MissingDirectory", workspaceRoot: missingWorkspace });
        expect(
          yield* findThread({
            claudeHomePath,
            codexHomePath,
            source: "codex",
            providerSessionId: excludedId,
          }),
        ).toEqual({ _tag: "ExcludedDirectory", workspaceRoot: NodeOS.homedir() });
      }),
    );
  });

  describe("claudeAgent", () => {
    it.effect("finds the session file named after the id", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(
            claudeHomePath,
            "projects",
            "-encoded-cwd",
            `${CLAUDE_SESSION_ID}.jsonl`,
          ),
          contents: claudeTranscript({ sessionId: CLAUDE_SESSION_ID, cwd: workspace }),
          mtimeMs: Date.parse("2026-08-24T10:01:00.000Z"),
        });

        const lookup = yield* findThread({
          claudeHomePath,
          codexHomePath,
          source: "claudeAgent",
          providerSessionId: CLAUDE_SESSION_ID,
        });

        expect(lookup).toMatchObject({
          _tag: "Found",
          workspaceRoot: workspace,
          thread: { source: "claudeAgent", providerSessionId: CLAUDE_SESSION_ID },
        });
        // A Codex lookup for the same id must not open Claude's file.
        expect(
          yield* findThread({
            claudeHomePath,
            codexHomePath,
            source: "codex",
            providerSessionId: CLAUDE_SESSION_ID,
          }),
        ).toEqual({ _tag: "NotFound" });
      }),
    );
  });
});
