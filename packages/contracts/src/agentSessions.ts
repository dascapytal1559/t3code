import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/** Imported message ids retain their origin after event metadata is projected into SQLite. */
export function isImportedAgentSessionMessageId(messageId: string): boolean {
  return messageId.startsWith("import:");
}

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedErrorClass<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedErrorClass<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

/** Import one provider session by its native id, creating the project its transcript names when needed. */
export const AgentSessionThreadImportInput = Schema.Struct({
  source: AgentSessionSource,
  providerSessionId: TrimmedNonEmptyString,
});
export type AgentSessionThreadImportInput = typeof AgentSessionThreadImportInput.Type;

export const AgentSessionThreadImportResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  /** True when the transcript's directory had no active project and one was created for it. */
  projectCreated: Schema.Boolean,
});
export type AgentSessionThreadImportResult = typeof AgentSessionThreadImportResult.Type;

export const AgentSessionThreadImportFailure = Schema.Literals([
  "not-found",
  "unreadable",
  "missing-directory",
  "excluded-directory",
  "thread-deleted",
  "import-failed",
]);
export type AgentSessionThreadImportFailure = typeof AgentSessionThreadImportFailure.Type;

const AGENT_SESSION_SOURCE_LABELS: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

export class AgentSessionThreadImportError extends Schema.TaggedErrorClass<AgentSessionThreadImportError>()(
  "AgentSessionThreadImportError",
  {
    source: AgentSessionSource,
    providerSessionId: TrimmedNonEmptyString,
    reason: AgentSessionThreadImportFailure,
    /** The transcript's working directory, for directory failures. */
    path: Schema.optional(Schema.String),
    /** The underlying failure, for import failures. */
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const label = AGENT_SESSION_SOURCE_LABELS[this.source];
    const session = `${label} session '${this.providerSessionId}'`;
    switch (this.reason) {
      case "not-found":
        return `${session} was not found in the configured ${label} home.`;
      case "unreadable":
        return `${session} has no readable transcript.`;
      case "missing-directory":
        return `${session} ran in '${this.path ?? "an unknown directory"}', which no longer exists.`;
      case "excluded-directory":
        return `${session} ran in '${this.path ?? "an unknown directory"}', which cannot be a project.`;
      case "thread-deleted":
        return `${session} was imported before and that thread has been deleted.`;
      case "import-failed":
        return `${session} could not be imported${this.detail ? `: ${this.detail}` : "."}`;
    }
  }
}

export interface AgentSessionThreadReference {
  readonly source: AgentSessionSource;
  readonly providerSessionId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_THREAD_URL_PATTERN = /^codex:\/\/threads\/([0-9a-f-]{36})\/?$/i;

/**
 * Read a pasted session reference: a `codex://threads/<id>` link from the
 * Codex app, or a bare session id. Codex mints UUIDv7 thread ids and Claude
 * Code mints UUIDv4 session ids, so the version nibble names the source.
 */
export function parseAgentSessionThreadReference(text: string): AgentSessionThreadReference | null {
  const trimmed = text.trim();
  const codexUrl = CODEX_THREAD_URL_PATTERN.exec(trimmed);
  if (codexUrl !== null) {
    const providerSessionId = codexUrl[1]!.toLowerCase();
    return UUID_PATTERN.test(providerSessionId) ? { source: "codex", providerSessionId } : null;
  }
  const bare = UUID_PATTERN.exec(trimmed);
  if (bare === null) return null;
  const providerSessionId = trimmed.toLowerCase();
  switch (bare[1]!.toLowerCase()) {
    case "7":
      return { source: "codex", providerSessionId };
    case "4":
      return { source: "claudeAgent", providerSessionId };
    default:
      return null;
  }
}

export class AgentSessionScanError extends Schema.TaggedErrorClass<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
