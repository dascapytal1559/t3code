import {
  USAGE_ORIGINS_RECORDED_SINCE,
  type UsageOrigin,
  type UsageOriginBasis,
  type UsageOriginVia,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as UsageClaims from "./UsageClaims.ts";

const ORIGINS_RECORDED_SINCE_MS = Date.parse(USAGE_ORIGINS_RECORDED_SINCE);

export interface UsageOriginKey {
  readonly origin: UsageOrigin;
  readonly basis: UsageOriginBasis;
  /** Set when the origin is the root of a recorded cause chain: who sent the prompt itself. */
  readonly via?: UsageOriginVia;
}

/** The stored provenance of one message; null fields were never recorded. */
export interface OriginMessage {
  readonly createdBy: string | null;
  readonly creationSource: string | null;
  readonly surface: string | null;
  readonly deviceType: string | null;
  /** The message's thread is FirstMate crew (`crewOf`). */
  readonly crew: boolean;
  /** A provider's background-task update (`notification`), posted as a prompt. */
  readonly notification: boolean;
}

/** A message and the prompt recorded as its cause: its own `causedBy`, else its thread's. */
export interface CausalMessage extends OriginMessage {
  readonly id: string;
  readonly runId: string | null;
  readonly causedBy: string | null;
}

/** A phone or computer origin. */
export type DeviceOriginKey = UsageOriginKey & { readonly origin: "phone" | "computer" };

/** Reads only what T3 recorded; an older message without a stamp is never upgraded to a device. */
export function classifyMessageOrigin(message: OriginMessage): UsageOriginKey {
  const key = recordedOrigin(message);
  return key.origin === "agent" && message.crew ? { ...key, origin: "crew" } : key;
}

function recordedOrigin(message: OriginMessage): UsageOriginKey {
  const { surface, deviceType } = message;
  if (surface !== null || deviceType !== null) {
    if (surface === "mcp" || deviceType === "bot") return { origin: "agent", basis: "stamp" };
    if (deviceType === "mobile" || deviceType === "tablet" || surface === "mobile") {
      return { origin: "phone", basis: "stamp" };
    }
    if (deviceType === "desktop" || surface === "desktop") {
      return { origin: "computer", basis: "stamp" };
    }
    return { origin: "unknown", basis: "stamp" };
  }
  if (message.notification) return { origin: "agent", basis: "notification" };
  if (message.creationSource === "mobile") return { origin: "phone", basis: "nativeApp" };
  if (
    message.createdBy === "agent" ||
    message.creationSource === "mcp" ||
    message.creationSource === "provider"
  ) {
    return { origin: "agent", basis: "sender" };
  }
  if (message.creationSource === "server") return { origin: "unknown", basis: "server" };
  return { origin: "unknown", basis: "unstamped" };
}

const sentByAgent = (key: UsageOriginKey): key is UsageOriginKey & { origin: UsageOriginVia } =>
  key.origin === "agent" || key.origin === "crew";
const isDevice = (key: UsageOriginKey): key is DeviceOriginKey =>
  key.origin === "phone" || key.origin === "computer";

/** Hops followed from an agent prompt toward its root; longer or broken chains keep the prompt's own origin. */
export const MAX_CAUSE_DEPTH = 8;

/**
 * An agent prompt counts to the phone or computer prompt at the root of its recorded causes, or,
 * when the chain ends at an uncaused prompt, to the device claimed for that prompt's run. Any
 * other root, a missing message, a cycle or a chain past MAX_CAUSE_DEPTH keeps its own origin.
 */
export function resolveMessageOrigin(
  message: CausalMessage,
  causeOf: (messageId: string) => CausalMessage | undefined,
  claimOfRun: (runId: string) => DeviceOriginKey | undefined = () => undefined,
): UsageOriginKey {
  const direct = classifyMessageOrigin(message);
  if (!sentByAgent(direct)) return direct;
  const seen = new Set([message.id]);
  let current = message;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const causeId = current.causedBy;
    if (causeId === null) {
      const claimed = current.runId === null ? undefined : claimOfRun(current.runId);
      return claimed === undefined
        ? direct
        : { origin: claimed.origin, basis: claimed.basis, via: direct.origin };
    }
    if (seen.has(causeId)) break;
    seen.add(causeId);
    const cause = causeOf(causeId);
    if (cause === undefined) break;
    const root = classifyMessageOrigin(cause);
    if (root.origin === "phone" || root.origin === "computer") {
      return { origin: root.origin, basis: root.basis, via: direct.origin };
    }
    if (!sentByAgent(root)) break;
    current = cause;
  }
  return direct;
}

const NO_PROMPT: UsageOriginKey = { origin: "unknown", basis: "noPrompt" };

/**
 * Where usage counts once nothing more is recorded. Usage with no recorded parent is unknown
 * `default`, its own category until a cause or claim links it. Usage from before T3 recorded
 * devices, or copied from another machine's archive, can never trace, so it keeps that label.
 */
export function settleOrigin(
  key: UsageOriginKey | null,
  timestampMs: number,
  archived: boolean,
): UsageOriginKey {
  if (key !== null && isDevice(key)) return key;
  if (archived) return { origin: "unknown", basis: "archive" };
  if (timestampMs < ORIGINS_RECORDED_SINCE_MS) {
    return { origin: "unknown", basis: "beforeOrigins" };
  }
  return {
    origin: "unknown",
    basis: "default",
    ...(key !== null && sentByAgent(key) ? { via: key.origin } : {}),
  };
}

/** A provider turn of one native session, keyed by the run's starting message. */
export interface OriginTurn {
  readonly sessionId: string;
  readonly threadId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly key: UsageOriginKey;
}

export interface OriginPrompt {
  readonly createdAtMs: number;
  readonly key: UsageOriginKey;
}

/** A T3 thread's own worktree: sessions working inside it are that thread's work. */
export interface OriginWorktree {
  readonly threadId: string;
  readonly directory: string;
}

/** A session or folder an agent claimed for a prompt, keyed by where that prompt counts. */
export interface OriginClaim {
  readonly kind: "session" | "directory";
  readonly target: string;
  readonly key: UsageOriginKey;
}

export interface UsageOriginSnapshot {
  readonly turns: readonly OriginTurn[];
  readonly prompts: readonly OriginPrompt[];
  readonly worktrees: readonly OriginWorktree[];
  readonly claims: readonly OriginClaim[];
}

export interface OriginRecord {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly cwd?: string | undefined;
}

// Records written this long after a turn ended belong to no T3 turn, such as a terminal resume.
const LATE_RECORD_GRACE_MS = 5 * 60 * 1000;

/** The last turn that started at or before the time; turns are sorted by start. */
function turnStartedBy(turns: readonly OriginTurn[], timestampMs: number): OriginTurn | undefined {
  let low = 0;
  let high = turns.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (turns[middle]!.startedAtMs <= timestampMs) low = middle + 1;
    else high = middle;
  }
  return turns[low - 1];
}

function isWithin(cwd: string, directory: string): boolean {
  if (!cwd.startsWith(directory)) return false;
  const next = cwd[directory.length];
  return next === undefined || next === "/" || next === "\\" || /[\\/]$/.test(directory);
}

type FolderOwner =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "worktree"; readonly directory: string }
  | { readonly kind: "claim"; readonly key: UsageOriginKey };

const byStart = (a: OriginTurn, b: OriginTurn) => a.startedAtMs - b.startedAtMs;

function appendTo<K>(index: Map<K, OriginTurn[]>, key: K, turns: readonly OriginTurn[]): void {
  const list = index.get(key);
  if (list === undefined) index.set(key, [...turns]);
  else list.push(...turns);
}

/**
 * Matches a transcript record to the T3 work it belongs to: the turn of its own native session
 * running at the time, else a claim on its session, else its working folder. A folder inside a
 * session's own folder (Claude names its scratchpad for the session), a thread's worktree, or a
 * claimed folder counts to the latest turn there, or to the claim; the deepest folder wins.
 */
export class UsageOriginIndex {
  readonly #turnsBySession = new Map<string, OriginTurn[]>();
  // Worktree slots are reused, so a folder holds the turns of every thread that worked there.
  readonly #turnsByWorktree = new Map<string, OriginTurn[]>();
  readonly #claimedSessions = new Map<string, UsageOriginKey>();
  /** Deepest first; a claim wins a tie with a worktree. */
  readonly #folders: { readonly directory: string; readonly owner: FolderOwner }[];
  // Records repeat their folder thousands of times; its owner does not depend on the time.
  readonly #ownerByCwd = new Map<string, FolderOwner | null>();

  constructor(snapshot: Pick<UsageOriginSnapshot, "turns" | "worktrees" | "claims">) {
    const turnsByThread = new Map<string, OriginTurn[]>();
    for (const turn of snapshot.turns) {
      appendTo(this.#turnsBySession, turn.sessionId, [turn]);
      appendTo(turnsByThread, turn.threadId, [turn]);
    }
    const folders: { directory: string; owner: FolderOwner }[] = [];
    for (const claim of snapshot.claims) {
      if (claim.kind === "session") this.#claimedSessions.set(claim.target, claim.key);
      else folders.push({ directory: claim.target, owner: { kind: "claim", key: claim.key } });
    }
    for (const { threadId, directory } of snapshot.worktrees) {
      if (!this.#turnsByWorktree.has(directory)) {
        folders.push({ directory, owner: { kind: "worktree", directory } });
      }
      appendTo(this.#turnsByWorktree, directory, turnsByThread.get(threadId) ?? []);
    }
    for (const turns of this.#turnsBySession.values()) turns.sort(byStart);
    for (const turns of this.#turnsByWorktree.values()) turns.sort(byStart);
    this.#folders = folders.toSorted((a, b) => b.directory.length - a.directory.length);
  }

  lookup(record: OriginRecord): UsageOriginKey | null {
    const own = this.#turnsBySession.get(record.sessionId);
    const turn = own === undefined ? undefined : turnStartedBy(own, record.timestampMs);
    if (
      turn !== undefined &&
      (turn.completedAtMs === null ||
        record.timestampMs <= turn.completedAtMs + LATE_RECORD_GRACE_MS)
    ) {
      return turn.key;
    }
    const claimed = this.#claimedSessions.get(record.sessionId);
    if (claimed !== undefined) return claimed;
    // A T3 session's record outside its turns is someone resuming it elsewhere, such as a terminal.
    if (own !== undefined || record.cwd === undefined) return null;
    const owner = this.#ownerOf(record.cwd);
    if (owner === null) return null;
    if (owner.kind === "claim") return owner.key;
    const turns =
      owner.kind === "session"
        ? this.#turnsBySession.get(owner.sessionId)
        : this.#turnsByWorktree.get(owner.directory);
    return (turns && turnStartedBy(turns, record.timestampMs)?.key) ?? null;
  }

  #ownerOf(cwd: string): FolderOwner | null {
    const cached = this.#ownerByCwd.get(cwd);
    if (cached !== undefined) return cached;
    const sessionId = cwd.split(/[\\/]/).find((segment) => this.#turnsBySession.has(segment));
    const owner: FolderOwner | null =
      sessionId !== undefined
        ? { kind: "session", sessionId }
        : (this.#folders.find((folder) => isWithin(cwd, folder.directory))?.owner ?? null);
    this.#ownerByCwd.set(cwd, owner);
    return owner;
  }
}

export class UsageOriginsReadError extends Schema.TaggedError<UsageOriginsReadError>()(
  "UsageOriginsReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the origins of T3 prompts.";
  }
}

export class UsageOrigins extends Context.Service<
  UsageOrigins,
  {
    readonly read: (
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<UsageOriginSnapshot, UsageOriginsReadError>;
  }
>()("t3/usage/UsageOrigins") {}

interface MessageColumns {
  readonly message_id: string;
  readonly run_id: string | null;
  readonly created_by: string | null;
  readonly creation_source: string | null;
  readonly surface: string | null;
  readonly device_type: string | null;
  readonly crew: number;
  readonly notification: number;
  readonly caused_by: string | null;
}

const messageOf = (row: MessageColumns): CausalMessage => ({
  id: row.message_id,
  runId: row.run_id,
  createdBy: row.created_by,
  creationSource: row.creation_source,
  surface: row.surface,
  deviceType: row.device_type,
  crew: row.crew === 1,
  notification: row.notification === 1,
  causedBy: row.caused_by,
});

const parseMs = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const MessageIdList = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeMessageIds = Schema.encodeSync(MessageIdList);

// A turn that started before the window can still be running in it.
const TURN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* UsageClaims.UsageClaims;

  // Columns of `message` (joined to its `thread`) that classify it and name its cause.
  const messageColumns = sql.literal(`
    message.message_id,
    message.run_id,
    json_extract(message.payload_json, '$.createdBy') AS created_by,
    json_extract(message.payload_json, '$.creationSource') AS creation_source,
    json_extract(message.payload_json, '$.origin.surface') AS surface,
    json_extract(message.payload_json, '$.origin.deviceType') AS device_type,
    json_extract(thread.payload_json, '$.crewOf') IS NOT NULL AS crew,
    json_extract(message.payload_json, '$.notification') IS NOT NULL AS notification,
    coalesce(
      json_extract(message.payload_json, '$.causedBy.messageId'),
      json_extract(thread.payload_json, '$.causedBy.messageId')
    ) AS caused_by`);

  // Loads the recorded causes of agent prompts, one chain hop per query.
  const loadCauses = Effect.fn("UsageOrigins.loadCauses")(function* (
    messages: ReadonlyArray<CausalMessage>,
  ) {
    const loaded = new Map<string, CausalMessage>();
    const causesToLoad = (from: ReadonlyArray<CausalMessage>) =>
      new Set(
        from.flatMap((message) =>
          message.causedBy !== null &&
          !loaded.has(message.causedBy) &&
          sentByAgent(classifyMessageOrigin(message))
            ? [message.causedBy]
            : [],
        ),
      );
    let pending = causesToLoad(messages);
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && pending.size > 0; depth++) {
      const rows = yield* sql<MessageColumns>`
        SELECT ${messageColumns}
        FROM orchestration_v2_projection_messages AS message
        LEFT JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = message.thread_id
        WHERE message.message_id IN (SELECT value FROM json_each(${encodeMessageIds([...pending])}))
      `.pipe(NodeSqliteClient.readOnly);
      const found = rows.map(messageOf);
      for (const message of found) loaded.set(message.id, message);
      pending = causesToLoad(found);
    }
    return loaded;
  });

  const read = Effect.fn("UsageOrigins.read")(
    function* (sinceMs: number, untilMs: number) {
      const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
      const since = iso(sinceMs);
      const until = iso(untilMs);
      const turnsSince = iso(sinceMs - TURN_LOOKBACK_MS);
      // A run's sender is its userMessageId's origin; later steering messages do not split it.
      const turnRows = yield* sql<
        Omit<MessageColumns, "message_id"> & {
          readonly message_id: string | null;
          readonly session_id: string | null;
          readonly thread_id: string;
          readonly turn_run_id: string | null;
          readonly worktree_path: string | null;
          readonly started_at: string | null;
          readonly completed_at: string | null;
        }
      >`
      SELECT json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') AS session_id,
        turn.thread_id,
        run.run_id AS turn_run_id,
        json_extract(thread.payload_json, '$.worktreePath') AS worktree_path,
        turn.started_at,
        turn.completed_at,
        ${messageColumns}
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_provider_threads AS provider_thread
        ON provider_thread.provider_thread_id = turn.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = turn.thread_id
      WHERE turn.started_at >= ${turnsSince} AND turn.started_at < ${until}
    `.pipe(NodeSqliteClient.readOnly);
      const promptRows = yield* sql<MessageColumns & { readonly created_at: string }>`
      SELECT message.created_at, ${messageColumns}
      FROM orchestration_v2_projection_messages AS message
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = message.thread_id
      WHERE message.role = 'user' AND message.created_at >= ${since} AND message.created_at < ${until}
    `.pipe(NodeSqliteClient.readOnly);

      const turnMessages = turnRows.map((row) =>
        row.message_id === null ? null : messageOf({ ...row, message_id: row.message_id }),
      );
      const promptMessages = promptRows.map(messageOf);
      // A claim names a device, or counts like an agent prompt caused by the prompt it names.
      const claimRows = yield* claims.read;
      const claimMessage = (claim: UsageClaims.StoredUsageClaim): CausalMessage | null =>
        claim.causeMessageId === null
          ? null
          : {
              id: `usage-claim:${claim.kind}:${claim.target}`,
              runId: null,
              createdBy: "agent",
              creationSource: "mcp",
              surface: "mcp",
              deviceType: "bot",
              crew: false,
              notification: false,
              causedBy: claim.causeMessageId,
            };
      const causes = yield* loadCauses([
        ...turnMessages.filter((message) => message !== null),
        ...promptMessages,
        ...claimRows.flatMap((claim) => claimMessage(claim) ?? []),
      ]);
      // Device claims settle first, so a cause claim can name a prompt inside a claimed turn.
      const runClaims = new Map<string, DeviceOriginKey>();
      for (const claim of claimRows) {
        if (claim.kind === "run" && claim.device !== null)
          runClaims.set(claim.target, { origin: claim.device, basis: "claim" });
      }
      const originOf = (message: CausalMessage) =>
        resolveMessageOrigin(
          message,
          (id) => causes.get(id),
          (runId) => runClaims.get(runId),
        );
      const claimKey = (claim: UsageClaims.StoredUsageClaim): UsageOriginKey => {
        const message = claimMessage(claim);
        return message === null
          ? { origin: claim.device ?? "computer", basis: "claim", via: "agent" }
          : originOf(message);
      };
      for (const claim of claimRows) {
        if (claim.kind !== "run" || claim.device !== null) continue;
        const key = claimKey(claim);
        if (isDevice(key)) runClaims.set(claim.target, { origin: key.origin, basis: key.basis });
      }

      const turns: OriginTurn[] = [];
      const worktrees = new Map<string, string>();
      turnRows.forEach((row, index) => {
        if (row.worktree_path !== null) worktrees.set(row.thread_id, row.worktree_path);
        const startedAtMs = parseMs(row.started_at);
        if (row.session_id === null || startedAtMs === null) return;
        const message = turnMessages[index] ?? null;
        const own = message === null ? NO_PROMPT : originOf(message);
        // A claimed turn counts there unless its own prompt already traces to a device.
        const claimed = row.turn_run_id === null ? undefined : runClaims.get(row.turn_run_id);
        turns.push({
          sessionId: row.session_id,
          threadId: row.thread_id,
          startedAtMs,
          completedAtMs: parseMs(row.completed_at),
          key:
            isDevice(own) || claimed === undefined
              ? own
              : { ...claimed, via: sentByAgent(own) ? own.origin : "agent" },
        });
      });
      const prompts: OriginPrompt[] = [];
      promptRows.forEach((row, index) => {
        const createdAtMs = parseMs(row.created_at);
        if (createdAtMs !== null)
          prompts.push({ createdAtMs, key: originOf(promptMessages[index]!) });
      });
      return {
        turns,
        prompts,
        worktrees: [...worktrees].map(([threadId, directory]) => ({ threadId, directory })),
        claims: claimRows.flatMap((claim): OriginClaim[] =>
          claim.kind === "run"
            ? []
            : [{ kind: claim.kind, target: claim.target, key: claimKey(claim) }],
        ),
      } satisfies UsageOriginSnapshot;
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  return UsageOrigins.of({ read });
});

export const layer = Layer.effect(UsageOrigins, make);
