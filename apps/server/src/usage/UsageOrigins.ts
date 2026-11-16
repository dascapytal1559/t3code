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
import * as UsageSessionRegister from "./UsageSessionRegister.ts";

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
 * An agent prompt counts to the phone or computer prompt at the root of its recorded causes. A
 * chain that reaches no device, whatever ends it, counts to the device claimed for the first run
 * along it, starting with the prompt's own. An unknown prompt counts to the device claimed for its
 * own run. With no claim either, the prompt keeps its own origin.
 */
export function resolveMessageOrigin(
  message: CausalMessage,
  causeOf: (messageId: string) => CausalMessage | undefined,
  claimOfRun: (runId: string) => DeviceOriginKey | undefined = () => undefined,
): UsageOriginKey {
  const claimedFor = (prompt: CausalMessage, via: UsageOriginVia): UsageOriginKey | undefined => {
    const claimed = prompt.runId === null ? undefined : claimOfRun(prompt.runId);
    return claimed === undefined
      ? undefined
      : { origin: claimed.origin, basis: claimed.basis, via };
  };
  const direct = classifyMessageOrigin(message);
  if (!sentByAgent(direct))
    return isDevice(direct) ? direct : (claimedFor(message, "agent") ?? direct);
  const seen = new Set([message.id]);
  const visited = [message];
  let current = message;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const causeId = current.causedBy;
    if (causeId === null || seen.has(causeId)) break;
    seen.add(causeId);
    const cause = causeOf(causeId);
    if (cause === undefined) break;
    const root = classifyMessageOrigin(cause);
    if (isDevice(root)) return { origin: root.origin, basis: root.basis, via: direct.origin };
    visited.push(cause);
    if (!sentByAgent(root)) break;
    current = cause;
  }
  for (const prompt of visited) {
    const claimed = claimedFor(prompt, direct.origin);
    if (claimed !== undefined) return claimed;
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
  /** A session claim's start; absent, it covers the whole session. */
  readonly fromMs?: number | undefined;
  readonly key: UsageOriginKey;
}

/**
 * A session T3 does not run, registered when it started, with the T3 thread whose environment
 * started it. A session whose environment named no thread or task started in a terminal.
 */
export interface OriginRegistration {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly threadId?: string;
}

/** A session started with no T3 thread or FirstMate task behind it: you, in a terminal. */
const TERMINAL_ORIGIN: DeviceOriginKey = { origin: "computer", basis: "terminal" };

export interface UsageOriginSnapshot {
  readonly turns: readonly OriginTurn[];
  readonly prompts: readonly OriginPrompt[];
  readonly worktrees: readonly OriginWorktree[];
  readonly claims: readonly OriginClaim[];
  readonly registrations: readonly OriginRegistration[];
}

export interface OriginRecord {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly cwd?: string | undefined;
}

// Records written this long after a turn ended belong to no T3 turn, such as a terminal resume.
const LATE_RECORD_GRACE_MS = 5 * 60 * 1000;

// The session-start hook stamps whole seconds, so a session may have started up to a second later.
const REGISTER_STAMP_SLACK_MS = 999;

/** The last item that started at or before the time; items are sorted by start. */
function startedBy<T extends { readonly startedAtMs: number }>(
  items: readonly T[],
  timestampMs: number,
): T | undefined {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.startedAtMs <= timestampMs) low = middle + 1;
    else high = middle;
  }
  return items[low - 1];
}

interface SessionClaim {
  readonly startedAtMs: number;
  readonly key: UsageOriginKey;
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

const byStart = (a: { startedAtMs: number }, b: { startedAtMs: number }) =>
  a.startedAtMs - b.startedAtMs;

function appendTo<K, T>(index: Map<K, T[]>, key: K, items: readonly T[]): void {
  const list = index.get(key);
  if (list === undefined) index.set(key, [...items]);
  else list.push(...items);
}

/**
 * Matches a record to the T3 work it belongs to: its own session's turn then, else its session's
 * latest claim, else its latest registration, else its working folder: a session's own folder
 * (Claude's scratchpad), a thread's worktree, or a claimed folder; the deepest folder wins.
 */
export class UsageOriginIndex {
  readonly #turnsBySession = new Map<string, OriginTurn[]>();
  readonly #turnsByThread = new Map<string, OriginTurn[]>();
  // Worktree slots are reused, so a folder holds the turns of every thread that worked there.
  readonly #turnsByWorktree = new Map<string, OriginTurn[]>();
  // A claim with no start covers the session from its beginning.
  readonly #claimsBySession = new Map<string, SessionClaim[]>();
  // A session resumed later registers again, from wherever it was resumed.
  readonly #registrationsBySession = new Map<string, OriginRegistration[]>();
  /** Deepest first; a claim wins a tie with a worktree. */
  readonly #folders: { readonly directory: string; readonly owner: FolderOwner }[];
  // Records repeat their folder thousands of times; its owner does not depend on the time.
  readonly #ownerByCwd = new Map<string, FolderOwner | null>();

  constructor(
    snapshot: Pick<UsageOriginSnapshot, "turns" | "worktrees" | "claims" | "registrations">,
  ) {
    for (const turn of snapshot.turns) {
      appendTo(this.#turnsBySession, turn.sessionId, [turn]);
      appendTo(this.#turnsByThread, turn.threadId, [turn]);
    }
    for (const registration of snapshot.registrations) {
      appendTo(this.#registrationsBySession, registration.sessionId, [registration]);
    }
    const folders: { directory: string; owner: FolderOwner }[] = [];
    for (const claim of snapshot.claims) {
      if (claim.kind === "session") {
        const startedAtMs = claim.fromMs ?? Number.NEGATIVE_INFINITY;
        appendTo(this.#claimsBySession, claim.target, [{ startedAtMs, key: claim.key }]);
      } else folders.push({ directory: claim.target, owner: { kind: "claim", key: claim.key } });
    }
    for (const { threadId, directory } of snapshot.worktrees) {
      if (!this.#turnsByWorktree.has(directory)) {
        folders.push({ directory, owner: { kind: "worktree", directory } });
      }
      appendTo(this.#turnsByWorktree, directory, this.#turnsByThread.get(threadId) ?? []);
    }
    for (const turns of this.#turnsBySession.values()) turns.sort(byStart);
    for (const turns of this.#turnsByThread.values()) turns.sort(byStart);
    for (const turns of this.#turnsByWorktree.values()) turns.sort(byStart);
    for (const claims of this.#claimsBySession.values()) claims.sort(byStart);
    for (const registrations of this.#registrationsBySession.values()) registrations.sort(byStart);
    this.#folders = folders.toSorted((a, b) => b.directory.length - a.directory.length);
  }

  lookup(record: OriginRecord): UsageOriginKey | null {
    const own = this.#turnsBySession.get(record.sessionId);
    const turn = own === undefined ? undefined : startedBy(own, record.timestampMs);
    if (
      turn !== undefined &&
      (turn.completedAtMs === null ||
        record.timestampMs <= turn.completedAtMs + LATE_RECORD_GRACE_MS)
    ) {
      return turn.key;
    }
    const claims = this.#claimsBySession.get(record.sessionId);
    const claimed = claims === undefined ? undefined : startedBy(claims, record.timestampMs);
    if (claimed !== undefined) return claimed.key;
    // A T3 session's record outside its turns is someone resuming it elsewhere, such as a terminal.
    if (own !== undefined) return null;
    const registered = this.#registrationsBySession.get(record.sessionId);
    const registration =
      registered === undefined ? undefined : startedBy(registered, record.timestampMs);
    if (registration !== undefined) {
      if (registration.threadId === undefined) return TERMINAL_ORIGIN;
      const turns = this.#turnsByThread.get(registration.threadId);
      const starter =
        turns === undefined
          ? undefined
          : startedBy(turns, registration.startedAtMs + REGISTER_STAMP_SLACK_MS);
      if (starter !== undefined) return starter.key;
    }
    if (record.cwd === undefined) return null;
    const owner = this.#ownerOf(record.cwd);
    if (owner === null) return null;
    if (owner.kind === "claim") return owner.key;
    const turns =
      owner.kind === "session"
        ? this.#turnsBySession.get(owner.sessionId)
        : this.#turnsByWorktree.get(owner.directory);
    return (turns && startedBy(turns, record.timestampMs)?.key) ?? null;
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

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

// A turn that started before the window can still be running in it.
const TURN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* UsageClaims.UsageClaims;
  const register = yield* UsageSessionRegister.UsageSessionRegister;

  // T3's own sessions register too, and are dropped: T3 knows them turn by turn. A FirstMate task
  // resolves to the thread it runs in, named by that thread's bound environment.
  const resolveRegistrations = Effect.fn("UsageOrigins.resolveRegistrations")(function* (
    registrations: ReadonlyArray<UsageSessionRegister.SessionRegistration>,
  ) {
    if (registrations.length === 0) return [];
    const sessionIds = [...new Set(registrations.map((entry) => entry.sessionId))];
    const ownRows = yield* sql<{ readonly native_id: string }>`
      SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
      FROM orchestration_v2_projection_provider_threads
      WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId')
        IN (SELECT value FROM json_each(${encodeIds(sessionIds)}))
    `.pipe(NodeSqliteClient.readOnly);
    const own = new Set(ownRows.map((row) => row.native_id));
    const taskIds = [...new Set(registrations.flatMap((entry) => entry.fmTaskId ?? []))];
    const taskRows =
      taskIds.length === 0
        ? []
        : yield* sql<{
            readonly thread_id: string;
            readonly created_at: string;
            readonly task_id: string;
            readonly home: string | null;
          }>`
            SELECT thread_id, created_at,
              json_extract(payload_json, '$.environment.FM_TASK_ID') AS task_id,
              json_extract(payload_json, '$.environment.FM_HOME') AS home
            FROM orchestration_v2_projection_threads
            WHERE json_extract(payload_json, '$.environment.FM_TASK_ID')
              IN (SELECT value FROM json_each(${encodeIds(taskIds)}))
          `.pipe(NodeSqliteClient.readOnly);
    // Newest first: a task id launched again names its latest thread by the session's start.
    const taskThreads = taskRows
      .flatMap((row) => {
        const createdAtMs = parseMs(row.created_at);
        return createdAtMs === null ? [] : [{ ...row, createdAtMs }];
      })
      .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
    return registrations.flatMap((entry): OriginRegistration[] => {
      if (own.has(entry.sessionId)) return [];
      const started = { sessionId: entry.sessionId, startedAtMs: entry.startedAtMs };
      const taskThread =
        entry.fmTaskId === undefined
          ? undefined
          : taskThreads.find(
              (thread) =>
                thread.task_id === entry.fmTaskId &&
                thread.home === (entry.fmHome ?? null) &&
                thread.createdAtMs <= entry.startedAtMs + REGISTER_STAMP_SLACK_MS,
            );
      const threadId = taskThread?.thread_id ?? entry.threadId;
      if (threadId !== undefined) return [{ ...started, threadId }];
      // FirstMate work with no thread T3 knows stays untraced rather than counting as a terminal.
      return entry.fmTaskId === undefined && entry.fmHome === undefined ? [started] : [];
    });
  });

  // Columns of `message` (joined to its `thread`) that classify it and name its cause.
  const messageColumns = sql.literal(`
    message.message_id,
    message.run_id,
    json_extract(message.payload_json, '$.createdBy') AS created_by,
    json_extract(message.payload_json, '$.creationSource') AS creation_source,
    json_extract(message.payload_json, '$.origin.surface') AS surface,
    json_extract(message.payload_json, '$.origin.deviceType') AS device_type,
    (
      json_extract(thread.payload_json, '$.crewOf') IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS root
        WHERE root.thread_id = json_extract(thread.payload_json, '$.lineage.rootThreadId')
          AND json_extract(root.payload_json, '$.crewOf') IS NOT NULL
      )
    ) AS crew,
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
        WHERE message.message_id IN (SELECT value FROM json_each(${encodeIds([...pending])}))
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
              id: `usage-claim:${claim.kind}:${claim.target}:${claim.fromMs ?? ""}`,
              runId: null,
              createdBy: "agent",
              creationSource: "mcp",
              surface: "mcp",
              deviceType: "bot",
              crew: false,
              notification: false,
              causedBy: claim.causeMessageId,
            };
      const registrations = yield* resolveRegistrations(
        yield* register.read(sinceMs - TURN_LOOKBACK_MS, untilMs),
      );
      const causes = yield* loadCauses([
        ...turnMessages.filter((message) => message !== null),
        ...promptMessages,
        ...claimRows.flatMap((claim) => claimMessage(claim) ?? []),
      ]);
      const runClaims = new Map(
        claimRows.flatMap((claim) =>
          claim.kind === "run" ? [[claim.target, claim] as const] : [],
        ),
      );
      // A run claim reached again while it resolves is a cycle and counts to no device.
      const settledRunClaims = new Map<string, DeviceOriginKey | undefined>();
      const resolving: string[] = [];
      let cycleAt = Number.POSITIVE_INFINITY;
      const claimOfRun = (runId: string): DeviceOriginKey | undefined => {
        if (settledRunClaims.has(runId)) return settledRunClaims.get(runId);
        const ancestor = resolving.indexOf(runId);
        if (ancestor >= 0) {
          cycleAt = Math.min(cycleAt, ancestor);
          return undefined;
        }
        const claim = runClaims.get(runId);
        if (claim === undefined) return undefined;
        const depth = resolving.length;
        const outerCycleAt = cycleAt;
        cycleAt = Number.POSITIVE_INFINITY;
        resolving.push(runId);
        const key = claimKey(claim);
        resolving.pop();
        const settled = isDevice(key) ? { origin: key.origin, basis: key.basis } : undefined;
        if (cycleAt >= depth) settledRunClaims.set(runId, settled);
        cycleAt = Math.min(outerCycleAt, cycleAt < depth ? cycleAt : Number.POSITIVE_INFINITY);
        return settled;
      };
      const originOf = (message: CausalMessage) =>
        resolveMessageOrigin(message, (id) => causes.get(id), claimOfRun);
      const claimKey = (claim: UsageClaims.StoredUsageClaim): UsageOriginKey => {
        const message = claimMessage(claim);
        return message === null
          ? { origin: claim.device ?? "computer", basis: "claim", via: "agent" }
          : originOf(message);
      };

      const turns: OriginTurn[] = [];
      const worktrees = new Map<string, string>();
      turnRows.forEach((row, index) => {
        if (row.worktree_path !== null) worktrees.set(row.thread_id, row.worktree_path);
        const startedAtMs = parseMs(row.started_at);
        if (row.session_id === null || startedAtMs === null) return;
        const message = turnMessages[index] ?? null;
        const own = message === null ? NO_PROMPT : originOf(message);
        // A claimed turn counts there unless its own prompt already traces to a device.
        const claimed = row.turn_run_id === null ? undefined : claimOfRun(row.turn_run_id);
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
            : [
                {
                  kind: claim.kind,
                  target: claim.target,
                  fromMs: claim.fromMs,
                  key: claimKey(claim),
                },
              ],
        ),
        registrations,
      } satisfies UsageOriginSnapshot;
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  return UsageOrigins.of({ read });
});

export const layer = Layer.effect(UsageOrigins, make);
