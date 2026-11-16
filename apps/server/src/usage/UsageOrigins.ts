import {
  USAGE_ORIGINS_RECORDED_SINCE,
  UsageOrigin,
  UsageOriginBasis,
  UsageOriginClaimKind,
  UsageOriginReason,
  type UsageOriginVia,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as UsageClaims from "./UsageClaims.ts";
import * as UsageClose from "./UsageClose.ts";
import * as UsageSessionRegister from "./UsageSessionRegister.ts";

const ORIGINS_RECORDED_SINCE_MS = Date.parse(USAGE_ORIGINS_RECORDED_SINCE);

export interface UsageOriginKey {
  readonly origin: UsageOrigin;
  readonly basis: UsageOriginBasis;
  /** Set when the origin is the root of a recorded cause chain: who sent the prompt itself. */
  readonly via?: UsageOriginVia;
  /** Why it counts there; not sent to clients, only to the reasons figure. */
  readonly reason: UsageOriginReason;
  /** The claim that decided it, if one did. */
  readonly claim?: UsageOriginClaimKind;
  /** Matched to a T3 turn by the folder its session ran in. */
  readonly folder?: true;
  /** Matched by the session's own registration at start. */
  readonly registered?: true;
  /** The typed prompt that decided it; absent when a rule did (a journal, upkeep, a terminal). */
  readonly root?: UsageOriginRoot;
  /** Decided by following a recorded `causedBy`, not a value stored when the work began. */
  readonly cause?: true;
}

/** A prompt by its thread and message ids. */
export interface UsageOriginRoot {
  readonly threadId: string;
  readonly messageId: string;
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
  /** A client's note of a click on a crew thread (a settle or a snooze): nobody typed it. */
  readonly click?: boolean;
}

/** A message and the prompt recorded as its cause: its own `causedBy`, else its thread's. */
export interface CausalMessage extends OriginMessage {
  readonly id: string;
  readonly runId: string | null;
  readonly causedBy: string | null;
  /** The message's thread is a pinned coordinator, such as FirstMate's own thread. */
  readonly coordinator: boolean;
  readonly threadId?: string;
  readonly createdAtMs?: number;
  /** The cause the message itself names; `causedBy` falls back to its thread's. */
  readonly ownCausedBy?: string | null;
  /** Bound by value when an agent's thread sent it from a typed turn: it re-roots its thread. */
  readonly usageOrigin?: UsageOriginKey;
  /** The crew thread a coordinator message speaks for: a typed reply, or a click (`click`). */
  readonly crewThreadId?: string;
  /** The origin its scheduled task was bound to when a turn created it. */
  readonly scheduledOrigin?: UsageOriginKey;
}

/** A phone or computer origin. */
export type DeviceOriginKey = UsageOriginKey & { readonly origin: "phone" | "computer" };

/** Reads only what T3 recorded; an older message without a stamp is never upgraded to a device. */
export function classifyMessageOrigin(message: OriginMessage): UsageOriginKey {
  const key = recordedOrigin(message);
  return key.origin === "agent" && message.crew ? { ...key, origin: "crew" } : key;
}

function recordedOrigin(message: OriginMessage): UsageOriginKey {
  if (message.click === true) return { origin: "agent", basis: "stamp", reason: "noCause" };
  const { surface, deviceType } = message;
  if (surface !== null || deviceType !== null) {
    if (surface === "mcp" || deviceType === "bot") {
      return { origin: "agent", basis: "stamp", reason: "noCause" };
    }
    if (deviceType === "mobile" || deviceType === "tablet" || surface === "mobile") {
      return { origin: "phone", basis: "stamp", reason: "typed" };
    }
    if (deviceType === "desktop" || surface === "desktop") {
      return { origin: "computer", basis: "stamp", reason: "typed" };
    }
    return { origin: "unknown", basis: "stamp", reason: "unknownDevice" };
  }
  if (message.notification)
    return { origin: "agent", basis: "notification", reason: "unnamedTurn" };
  if (message.creationSource === "mobile") {
    return { origin: "phone", basis: "nativeApp", reason: "typed" };
  }
  if (
    message.createdBy === "agent" ||
    message.creationSource === "mcp" ||
    message.creationSource === "provider"
  ) {
    return { origin: "agent", basis: "sender", reason: "noCause" };
  }
  if (message.creationSource === "server") {
    return { origin: "unknown", basis: "server", reason: "serverPrompt" };
  }
  return { origin: "unknown", basis: "unstamped", reason: "unstamped" };
}

const sentByAgent = (key: UsageOriginKey): key is UsageOriginKey & { origin: UsageOriginVia } =>
  key.origin === "agent" || key.origin === "crew";
const isDevice = (key: UsageOriginKey): key is DeviceOriginKey =>
  key.origin === "phone" || key.origin === "computer";

/** Hops followed from an agent prompt toward its root; longer or broken chains keep the prompt's own origin. */
export const MAX_CAUSE_DEPTH = 8;

/**
 * A coordinator's prompt that no person typed, in a turn no claim named, is the coordinator's own
 * upkeep (recovery, scheduled checks, background commands, restart notes): it counts to the computer.
 */
function upkeepOf(prompt: CausalMessage): DeviceOriginKey | undefined {
  if (!prompt.coordinator) return undefined;
  const own = classifyMessageOrigin(prompt);
  return sentByAgent(own) || own.reason === "serverPrompt"
    ? { origin: "computer", basis: own.basis, reason: "upkeep" }
    : undefined;
}

/**
 * An agent prompt counts to the phone or computer prompt at the root of its recorded causes. A
 * chain reaching no device counts to the first claimed run along it, else to upkeep if a
 * coordinator's unclaimed turn is on it; an unknown prompt, to its own run's. Else it keeps its own.
 */
export function resolveMessageOrigin(
  message: CausalMessage,
  causeOf: (messageId: string) => CausalMessage | undefined,
  claimOfRun: (runId: string) => DeviceOriginKey | undefined = () => undefined,
  // A claim whose cause reaches no device still names its turn, so it is not filed as upkeep.
  runClaimed: (runId: string) => boolean = (runId) => claimOfRun(runId) !== undefined,
  // A click on a crew thread counts where that thread's work counted then.
  clickedOf: (prompt: CausalMessage) => UsageOriginKey | undefined = () => undefined,
): UsageOriginKey {
  // A send T3 bound from a typed turn counts there; a click, where its crew thread's work counted.
  const boundFor = (prompt: CausalMessage, via?: UsageOriginVia): UsageOriginKey | undefined => {
    const key = prompt.usageOrigin ?? (prompt.click === true ? clickedOf(prompt) : undefined);
    return key === undefined || !isDevice(key) ? undefined : withVia(key, via);
  };
  const claimedFor = (prompt: CausalMessage, via: UsageOriginVia): UsageOriginKey | undefined => {
    const claimed = prompt.runId === null ? undefined : claimOfRun(prompt.runId);
    return claimed === undefined ? undefined : { ...claimed, via, claim: "run" };
  };
  const filedFor = (prompt: CausalMessage, via?: UsageOriginVia): UsageOriginKey | undefined => {
    if (prompt.runId !== null && runClaimed(prompt.runId)) return undefined;
    const upkeep = upkeepOf(prompt);
    return upkeep === undefined || via === undefined ? upkeep : { ...upkeep, via };
  };
  const byCause = (key: UsageOriginKey): UsageOriginKey => ({ ...key, cause: true });
  const direct = classifyMessageOrigin(message);
  if (isDevice(direct)) return withRoot(direct, message);
  // Any prompt nobody typed counts where T3 bound it, whoever sent it.
  const ownBound = boundFor(message, sentByAgent(direct) ? direct.origin : undefined);
  if (ownBound !== undefined) return ownBound;
  if (!sentByAgent(direct)) return claimedFor(message, "agent") ?? filedFor(message) ?? direct;
  const seen = new Set([message.id]);
  const visited = [message];
  let current = message;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const causeId = current.causedBy;
    if (causeId === null || seen.has(causeId)) break;
    seen.add(causeId);
    const cause = causeOf(causeId);
    if (cause === undefined) break;
    const causeBound = boundFor(cause, direct.origin);
    if (causeBound !== undefined) return byCause(causeBound);
    const root = classifyMessageOrigin(cause);
    if (isDevice(root)) {
      return byCause(
        withRoot(
          { origin: root.origin, basis: root.basis, reason: "inherited" },
          cause,
          direct.origin,
        ),
      );
    }
    visited.push(cause);
    if (!sentByAgent(root)) break;
    current = cause;
  }
  // Past the message itself, a claim or upkeep is reached only by following its causes.
  for (const [hop, prompt] of visited.entries()) {
    const claimed = claimedFor(prompt, direct.origin);
    if (claimed !== undefined) return hop === 0 ? claimed : byCause(claimed);
  }
  for (const [hop, prompt] of visited.entries()) {
    const filed = filedFor(prompt, direct.origin);
    if (filed !== undefined) return hop === 0 ? filed : byCause(filed);
  }
  return message.causedBy === null ? direct : byCause({ ...direct, reason: "untracedCause" });
}

/** A typed prompt's origin, naming that prompt as its root. */
function withRoot(
  key: UsageOriginKey,
  prompt: CausalMessage,
  via?: UsageOriginVia,
): UsageOriginKey {
  const root =
    prompt.threadId === undefined ? undefined : { threadId: prompt.threadId, messageId: prompt.id };
  return {
    ...key,
    ...(via === undefined ? {} : { via }),
    ...(root === undefined ? {} : { root }),
  };
}

const NO_PROMPT: UsageOriginKey = { origin: "unknown", basis: "noPrompt", reason: "noPrompt" };
const NO_PROMPT_UPKEEP: UsageOriginKey = {
  origin: "computer",
  basis: "noPrompt",
  reason: "upkeep",
};

/** Where a usage record came from: this machine's transcripts, an archive, or a provider account. */
export type UsageRecordSource = "live" | "archive" | "account";

/**
 * Where usage counts once nothing more is recorded: with no phone or computer evidence, the
 * computer, keeping why in `reason` and, for agent work, who sent it. Usage that can never trace
 * (before T3 recorded devices, another machine's archive, an account's history) says so in its basis.
 */
export function settleOrigin(
  key: UsageOriginKey,
  timestampMs: number,
  source: UsageRecordSource,
): UsageOriginKey {
  if (isDevice(key)) return key;
  if (source !== "live") {
    return {
      origin: "computer",
      basis: "archive",
      reason: source === "account" ? "accountOnly" : "archive",
    };
  }
  if (timestampMs < ORIGINS_RECORDED_SINCE_MS) {
    return { origin: "computer", basis: "beforeOrigins", reason: "beforeStamps" };
  }
  return {
    ...key,
    origin: "computer",
    basis: "default",
    ...(sentByAgent(key) ? { via: key.origin } : {}),
  };
}

const withoutVia = ({
  via: _via,
  folder: _folder,
  registered: _registered,
  ...key
}: UsageOriginKey): UsageOriginKey => key;
const withVia = (key: UsageOriginKey, via: UsageOriginVia | undefined): UsageOriginKey =>
  via === undefined ? withoutVia(key) : { ...withoutVia(key), via };

const viaOf = (message: CausalMessage): UsageOriginVia | undefined => {
  const own = classifyMessageOrigin(message);
  return sentByAgent(own) ? own.origin : undefined;
};

/** A prompt a person typed on a phone or a computer, as its own root; a click never is one. */
const typedOrigin = (message: CausalMessage): DeviceOriginKey | undefined => {
  const own = classifyMessageOrigin(message);
  return isDevice(own) ? { ...withRoot(own, message), origin: own.origin } : undefined;
};

/**
 * Where a message moves the work of its thread from then on: a prompt typed on it, a send T3 bound
 * from a typed turn, or an older send whose own recorded cause was a typed prompt. A prompt the
 * server bound (a restart's) counts where it was bound, and moves nothing.
 */
function rootOfMessage(
  message: CausalMessage,
  causeOf: (messageId: string) => CausalMessage | undefined,
): UsageOriginKey | undefined {
  const typed = typedOrigin(message);
  if (typed !== undefined) return typed;
  if (message.usageOrigin !== undefined && message.creationSource !== "server")
    return message.usageOrigin;
  const causeId = message.ownCausedBy ?? null;
  const cause = causeId === null ? undefined : causeOf(causeId);
  const root = cause === undefined || viaOf(message) === undefined ? undefined : typedOrigin(cause);
  return root === undefined
    ? undefined
    : { origin: root.origin, basis: root.basis, reason: "inherited", cause: true, ...rootOf(root) };
}

const rootOf = (key: UsageOriginKey) => (key.root === undefined ? {} : { root: key.root });

/** A time from which a work thread's usage counts somewhere: its birth, or a root that moved it. */
export interface OriginEntry {
  readonly startedAtMs: number;
  /** The run of the message that made it; null for a birth or a reply typed on its coordinator. */
  readonly runId: string | null;
  readonly key: UsageOriginKey;
  readonly via?: UsageOriginVia;
  /** Typed on this thread, so what its run sends re-roots the work it reaches. */
  readonly typed?: true;
}

/** A thread that is one piece of work, not a coordinator, with what decides its origin. */
export interface WorkThread {
  readonly createdAtMs: number;
  /** Bound by value at launch, else the device its recorded cause reaches. */
  readonly birth?: UsageOriginKey;
  /** Its user messages, oldest first. */
  readonly messages: readonly CausalMessage[];
  /** Replies typed on its box, which reach its coordinator's chat instead. */
  readonly replies: readonly OriginEntry[];
}

/**
 * A work thread's origin over time: born where the thread that launched it counted, then moved by
 * each typed message that reaches it, until the next. A scheduled task's first run is a birth.
 */
function workTimeline(
  thread: WorkThread,
  causeOf: (messageId: string) => CausalMessage | undefined,
): OriginEntry[] {
  const entries: OriginEntry[] =
    thread.birth === undefined
      ? []
      : [{ startedAtMs: thread.createdAtMs, runId: null, key: withoutVia(thread.birth) }];
  for (const message of thread.messages) {
    if (message.createdAtMs === undefined) continue;
    const key =
      rootOfMessage(message, causeOf) ??
      (entries.length === 0 ? message.scheduledOrigin : undefined);
    if (key === undefined) continue;
    const via = viaOf(message);
    entries.push({
      startedAtMs: message.createdAtMs,
      runId: message.runId,
      key: withoutVia(key),
      ...(via === undefined ? {} : { via }),
      ...(typedOrigin(message) === undefined ? {} : { typed: true }),
    });
  }
  return [...entries, ...thread.replies].toSorted(byStart);
}

/** A provider turn with what decides where its usage counts. */
export interface TurnFacts {
  readonly sessionId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  /** The message that started its run. */
  readonly message: CausalMessage | null;
  readonly coordinator: boolean;
}

/** Part of a turn that counts one way from its start; `typed` when a typed prompt decided it. */
export interface OriginSegment extends OriginTurn {
  readonly typed: boolean;
}

export interface OriginResolver {
  readonly causeOf: (messageId: string) => CausalMessage | undefined;
  /** The recorded resolution: causes, claims, upkeep, and clicks. */
  readonly originOf: (message: CausalMessage) => UsageOriginKey;
  readonly claimOfRun: (runId: string) => DeviceOriginKey | undefined;
  readonly runClaimed: (runId: string) => boolean;
  readonly timelineOf: (threadId: string) => readonly OriginEntry[];
  /** A coordinator run's prompts, the starting one included. */
  readonly runPrompts: (runId: string) => readonly CausalMessage[];
}

/**
 * Where a turn's usage counts, split where a typed prompt (or, in a work thread, a root that
 * re-roots it) arrives mid-turn. A coordinator's turn counts by its own prompt or claim; a work
 * thread's by its own root, else a claim on it, else the work's origin when it started.
 */
function turnSegments(turn: TurnFacts, resolver: OriginResolver): OriginSegment[] {
  const { message } = turn;
  const endMs = turn.completedAtMs ?? Number.POSITIVE_INFINITY;
  const segment = (startedAtMs: number, key: UsageOriginKey, typed: boolean): OriginSegment => ({
    sessionId: turn.sessionId,
    threadId: turn.threadId,
    runId: turn.runId,
    startedAtMs,
    completedAtMs: turn.completedAtMs,
    key,
    typed,
  });
  const within = (atMs: number | undefined): atMs is number =>
    atMs !== undefined && atMs > turn.startedAtMs && atMs <= endMs;
  const startTyped = message !== null && typedOrigin(message) !== undefined;
  const claimed = turn.runId === null ? undefined : resolver.claimOfRun(turn.runId);
  const first = (key: UsageOriginKey) =>
    segment(turn.startedAtMs, key, startTyped || key.reason === "journal");
  if (turn.coordinator) {
    const unnamedUpkeep = turn.runId === null || !resolver.runClaimed(turn.runId);
    const own =
      message !== null ? resolver.originOf(message) : unnamedUpkeep ? NO_PROMPT_UPKEEP : NO_PROMPT;
    const key =
      isDevice(own) || claimed === undefined
        ? own
        : { ...claimed, via: sentByAgent(own) ? own.origin : "agent", claim: "run" as const };
    const steers = (turn.runId === null ? [] : resolver.runPrompts(turn.runId)).flatMap(
      (prompt) => {
        const typed = typedOrigin(prompt);
        return typed !== undefined && prompt.id !== message?.id && within(prompt.createdAtMs)
          ? [segment(prompt.createdAtMs, typed, true)]
          : [];
      },
    );
    return [first(key), ...steers].toSorted(byStart);
  }
  const timeline = resolver.timelineOf(turn.threadId);
  const via = message === null ? undefined : viaOf(message);
  const own = message === null ? undefined : ownOrigin(message, resolver);
  const inherited = startedBy(timeline, turn.startedAtMs);
  const key =
    own !== undefined
      ? withVia(own, via)
      : claimed !== undefined
        ? { ...claimed, via: via ?? "agent", claim: "run" as const }
        : inherited !== undefined
          ? withVia(inherited.key, via)
          : message !== null
            ? resolver.originOf(message)
            : NO_PROMPT;
  const reroots = timeline.flatMap((entry) =>
    within(entry.startedAtMs) && (entry.runId === null || entry.runId === turn.runId)
      ? [
          segment(
            entry.startedAtMs,
            withVia(entry.key, entry.via),
            entry.typed === true && entry.runId === turn.runId,
          ),
        ]
      : [],
  );
  return [first(key), ...reroots].toSorted(byStart);
}

/** A work thread's prompt that decides its own origin: a root, a scheduled run, a server's bind. */
const ownOrigin = (message: CausalMessage, resolver: OriginResolver): UsageOriginKey | undefined =>
  rootOfMessage(message, resolver.causeOf) ??
  message.scheduledOrigin ??
  (message.usageOrigin !== undefined && isDevice(message.usageOrigin)
    ? message.usageOrigin
    : undefined);

/** Where a prompt counts, by the same rules as the turn it starts. */
function promptOrigin(message: CausalMessage, resolver: OriginResolver): UsageOriginKey {
  if (message.coordinator || message.threadId === undefined) return resolver.originOf(message);
  const via = viaOf(message);
  const own = ownOrigin(message, resolver);
  if (own !== undefined) return withVia(own, via);
  const claimed = message.runId === null ? undefined : resolver.claimOfRun(message.runId);
  if (claimed !== undefined) return { ...claimed, via: via ?? "agent", claim: "run" };
  const inherited =
    message.createdAtMs === undefined
      ? undefined
      : startedBy(resolver.timelineOf(message.threadId), message.createdAtMs);
  return inherited !== undefined ? withVia(inherited.key, via) : resolver.originOf(message);
}

/** A provider turn of one native session, keyed by the run's starting message. */
export interface OriginTurn {
  readonly sessionId: string;
  readonly threadId: string;
  readonly runId?: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly key: UsageOriginKey;
  /** A typed prompt (or a voice journal) decided it, so work bound from it re-roots. */
  readonly typed?: boolean;
}

export interface OriginPrompt {
  readonly createdAtMs: number;
  readonly key: UsageOriginKey;
  readonly messageId?: string;
  readonly threadId?: string;
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
  /** FirstMate work naming no thread T3 knows: never traced by, only reported apart. */
  readonly unmatched?: true;
}

/** A session started with no T3 thread or FirstMate task behind it: you, in a terminal. */
const TERMINAL_ORIGIN: DeviceOriginKey = {
  origin: "computer",
  basis: "terminal",
  reason: "terminal",
  registered: true,
};

/** A work thread's origin over time, for usage of its sessions outside its turns. */
export interface OriginTimeline {
  readonly threadId: string;
  readonly entries: readonly { readonly startedAtMs: number; readonly key: UsageOriginKey }[];
}

export interface UsageOriginSnapshot {
  readonly turns: readonly OriginTurn[];
  readonly prompts: readonly OriginPrompt[];
  readonly worktrees: readonly OriginWorktree[];
  readonly claims: readonly OriginClaim[];
  readonly registrations: readonly OriginRegistration[];
  /** Work threads with turns here; a coordinator has none. */
  readonly timelines?: readonly OriginTimeline[];
}

/** Nothing to label by: a window entirely closed reads no live origins. */
export const EMPTY_SNAPSHOT: UsageOriginSnapshot = {
  turns: [],
  prompts: [],
  worktrees: [],
  claims: [],
  registrations: [],
};

export interface OriginRecord {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly cwd?: string | undefined;
}

// Work launched or sent this long after its caller's turn ended still binds to that turn.
const BIND_GRACE_MS = 5 * 60 * 1000;

// The session-start hook stamps whole seconds, so a session may have started up to a second later.
const REGISTER_STAMP_SLACK_MS = 999;

const missed = (reason: UsageOriginReason): UsageOriginKey => ({
  origin: "unknown",
  basis: "default",
  reason,
});
const UNREGISTERED_SESSION = missed("unregisteredSession");
const UNMATCHED_REGISTRATION = missed("unmatchedRegistration");

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
  readonly #unmatchedSessions = new Set<string>();
  readonly #timelines = new Map<string, OriginTimeline["entries"]>();
  /** Deepest first; a claim wins a tie with a worktree. */
  readonly #folders: { readonly directory: string; readonly owner: FolderOwner }[];
  // Records repeat their folder thousands of times; its owner does not depend on the time.
  readonly #ownerByCwd = new Map<string, FolderOwner | null>();

  constructor(
    snapshot: Pick<
      UsageOriginSnapshot,
      "turns" | "worktrees" | "claims" | "registrations" | "timelines"
    >,
  ) {
    for (const { threadId, entries } of snapshot.timelines ?? []) {
      this.#timelines.set(threadId, entries);
    }
    for (const turn of snapshot.turns) {
      appendTo(this.#turnsBySession, turn.sessionId, [turn]);
      appendTo(this.#turnsByThread, turn.threadId, [turn]);
    }
    for (const registration of snapshot.registrations) {
      if (registration.unmatched === true) this.#unmatchedSessions.add(registration.sessionId);
      else appendTo(this.#registrationsBySession, registration.sessionId, [registration]);
    }
    const folders: { directory: string; owner: FolderOwner }[] = [];
    for (const claim of snapshot.claims) {
      const key: UsageOriginKey = { ...claim.key, claim: claim.kind };
      if (claim.kind === "session") {
        const startedAtMs = claim.fromMs ?? Number.NEGATIVE_INFINITY;
        appendTo(this.#claimsBySession, claim.target, [{ startedAtMs, key }]);
      } else folders.push({ directory: claim.target, owner: { kind: "claim", key } });
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

  /** A record that matches no T3 work gets an unknown key saying why. */
  lookup(record: OriginRecord): UsageOriginKey {
    const running = this.turnAt(record);
    if (running !== undefined) return running.key;
    const own = this.#turnsBySession.get(record.sessionId);
    const turn = own === undefined ? undefined : startedBy(own, record.timestampMs);
    const claims = this.#claimsBySession.get(record.sessionId);
    const claimed = claims === undefined ? undefined : startedBy(claims, record.timestampMs);
    if (claimed !== undefined) return claimed.key;
    // Outside its turns (background work running on), a T3 session counts with its thread.
    if (own !== undefined) {
      const latest = turn ?? own[0]!;
      return this.#movedSince(latest, latest.startedAtMs, record.timestampMs);
    }
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
      if (starter !== undefined)
        return {
          ...this.#movedSince(starter, registration.startedAtMs, record.timestampMs),
          registered: true,
        };
    }
    // A registration that names no turn still says the session announced itself.
    const miss =
      registered === undefined && !this.#unmatchedSessions.has(record.sessionId)
        ? UNREGISTERED_SESSION
        : UNMATCHED_REGISTRATION;
    const owner = record.cwd === undefined ? null : this.#ownerOf(record.cwd);
    if (owner === null) return miss;
    if (owner.kind === "claim") return owner.key;
    const turns =
      owner.kind === "session"
        ? this.#turnsBySession.get(owner.sessionId)
        : this.#turnsByWorktree.get(owner.directory);
    const key = turns && startedBy(turns, record.timestampMs)?.key;
    return key === undefined ? miss : { ...key, folder: true };
  }

  /** The part of its session's turn the record fell in, if one was running then. */
  turnAt(record: OriginRecord): OriginTurn | undefined {
    const own = this.#turnsBySession.get(record.sessionId);
    const turn = own === undefined ? undefined : startedBy(own, record.timestampMs);
    return turn !== undefined &&
      (turn.completedAtMs === null || record.timestampMs <= turn.completedAtMs)
      ? turn
      : undefined;
  }

  /**
   * A turn's label, unless its work thread was moved after `sinceMs`: then where that work counts
   * at the time. A coordinator is not one piece of work, so its turn's label stays.
   */
  #movedSince(turn: OriginTurn, sinceMs: number, timestampMs: number): UsageOriginKey {
    const timeline = this.#timelines.get(turn.threadId);
    const entry = timeline === undefined ? undefined : startedBy(timeline, timestampMs);
    return entry === undefined || entry.startedAtMs <= sinceMs
      ? turn.key
      : withVia(entry.key, turn.key.via);
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

/**
 * Where a thread's work counted at a moment, as T3 binds it when that thread launches or sends
 * work. `reroots` when a prompt typed in the turn running then (or a voice journal) decided it.
 */
export interface BoundOrigin {
  readonly key: UsageOriginKey;
  readonly reroots: boolean;
  /** The run of the turn running then, if one was. */
  readonly runId: string | null;
}

export class UsageOrigins extends Context.Service<
  UsageOrigins,
  {
    readonly read: (
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<UsageOriginSnapshot, UsageOriginsReadError>;
    /** Null when T3 has no such thread. */
    readonly originAt: (
      threadId: string,
      atMs: number,
    ) => Effect.Effect<BoundOrigin | null, UsageOriginsReadError>;
    /** Every run of the scheduled task counts here from now on. */
    readonly bindScheduledTask: (
      taskId: string,
      key: UsageOriginKey,
    ) => Effect.Effect<void, UsageOriginsReadError>;
    /** How far labels are written down; null before the first close. */
    readonly closedSpan: Effect.Effect<UsageClose.ClosedSpan | null, UsageOriginsReadError>;
    /** These sessions' stored labels, and the prompts labelled in the window's closed part. */
    readonly readClosed: (input: {
      readonly span: UsageClose.ClosedSpan;
      readonly sessionIds: readonly string[];
      readonly sinceMs: number;
      readonly untilMs: number;
    }) => Effect.Effect<
      { readonly labels: UsageClose.ClosedLabels; readonly prompts: readonly OriginPrompt[] },
      UsageOriginsReadError
    >;
    /**
     * Writes down the label of every record and prompt after the last close through `throughMs`,
     * as Usage reads them now, then reads them back; anything read back differently rolls it back.
     */
    readonly close: (
      throughMs: number,
      records: readonly OriginRecord[],
    ) => Effect.Effect<CloseOutcome, UsageOriginsReadError>;
  }
>()("t3/usage/UsageOrigins") {}

export type CloseOutcome =
  | {
      readonly closed: true;
      readonly span: UsageClose.ClosedSpan;
      readonly records: number;
      readonly sessionRows: number;
      readonly promptRows: number;
    }
  | { readonly closed: false; readonly why: "notDue" | "superseded" | "differs" };

/**
 * Where a thread's work counted at a closed time, from its sessions' stored labels, newest first:
 * the turn running then or ended within the bind grace, else a coordinator's upkeep. Undefined
 * for a work thread between its turns: its timeline says where the work counts, and a record's
 * label there can be a claim on its last run, which names that run only.
 */
function closedBound(
  rows: readonly UsageClose.ClosedSessionLabel[],
  atMs: number,
  coordinator: boolean,
): BoundOrigin | undefined {
  if (rows.length === 0) return undefined;
  const turnAt = rows.findIndex((row) => row.runId !== null);
  const turn = rows[turnAt];
  // The first row after a turn's own starts when that turn ended.
  if (turn !== undefined && (turnAt === 0 || atMs < rows[turnAt - 1]!.fromMs + BIND_GRACE_MS))
    return { key: turn.key, reroots: turn.typed, runId: turn.runId };
  return coordinator ? { key: NO_PROMPT_UPKEEP, reroots: false, runId: null } : undefined;
}

/** The origin T3 stores by value for work it binds, stripped of how this read matched it. */
export const storedOrigin = (key: UsageOriginKey) => ({
  origin: key.origin,
  basis: key.basis,
  // The bound work was not typed itself: it inherits the typed prompt behind it.
  reason: key.reason === "typed" ? "inherited" : key.reason,
  ...(key.claim === undefined ? {} : { claim: key.claim }),
  ...rootOf(key),
});

const StoredRoot = Schema.Struct({ threadId: Schema.String, messageId: Schema.String });

const StoredOriginJson = Schema.fromJsonString(
  Schema.Struct({
    origin: UsageOrigin,
    basis: UsageOriginBasis,
    reason: UsageOriginReason,
    claim: Schema.optional(UsageOriginClaimKind),
    root: Schema.optional(StoredRoot),
  }),
);
const decodeStoredOrigin = Schema.decodeUnknownOption(StoredOriginJson);
const encodeStoredOrigin = Schema.encodeSync(StoredOriginJson);

const isBasis = Schema.is(UsageOriginBasis);
const isReason = Schema.is(UsageOriginReason);
const isClaimKind = Schema.is(UsageOriginClaimKind);

/** A claim's device bound by value, with how the work it came from was read. */
const boundClaimKey = (
  origin: "phone" | "computer",
  bound: UsageClaims.UsageClaimBinding,
): UsageOriginKey | undefined =>
  isBasis(bound.basis) &&
  isReason(bound.reason) &&
  (bound.claim === undefined || isClaimKind(bound.claim))
    ? {
        origin,
        basis: bound.basis,
        reason: bound.reason,
        ...(bound.claim === undefined ? {} : { claim: bound.claim }),
        ...(bound.root === undefined ? {} : { root: bound.root }),
      }
    : undefined;

/** Bound for work whose thread has nothing recorded to count it by. */
const NO_ORIGIN_BOUND: UsageOriginKey = { origin: "unknown", basis: "default", reason: "noCause" };

/** A stored origin a later version cannot read is left out rather than guessed. */
const storedOriginOf = (json: string | null): UsageOriginKey | undefined => {
  if (json === null) return undefined;
  const decoded = decodeStoredOrigin(json);
  if (Option.isNone(decoded)) return undefined;
  const { claim, root, ...key } = decoded.value;
  return {
    ...key,
    ...(claim === undefined ? {} : { claim }),
    ...(root === undefined ? {} : { root }),
  };
};

interface MessageColumns {
  readonly message_id: string;
  readonly message_thread_id: string | null;
  readonly message_created_at: string | null;
  readonly run_id: string | null;
  readonly created_by: string | null;
  readonly creation_source: string | null;
  readonly surface: string | null;
  readonly device_type: string | null;
  readonly crew: number;
  readonly notification: number;
  readonly caused_by: string | null;
  readonly own_caused_by: string | null;
  readonly usage_origin: string | null;
  readonly crew_thread_id: string | null;
  readonly crew_note_kind: string | null;
  readonly scheduled_task_id: string | null;
  readonly coordinator: number;
}

const parseMs = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const messageOf = (
  row: MessageColumns,
  scheduledOrigins: ReadonlyMap<string, UsageOriginKey>,
): CausalMessage => {
  const createdAtMs = parseMs(row.message_created_at);
  const usageOrigin = storedOriginOf(row.usage_origin);
  const scheduledOrigin =
    row.scheduled_task_id === null ? undefined : scheduledOrigins.get(row.scheduled_task_id);
  return {
    id: row.message_id,
    runId: row.run_id,
    createdBy: row.created_by,
    creationSource: row.creation_source,
    surface: row.surface,
    deviceType: row.device_type,
    crew: row.crew === 1,
    notification: row.notification === 1,
    causedBy: row.caused_by,
    coordinator: row.coordinator === 1,
    ownCausedBy: row.own_caused_by,
    ...(row.crew_note_kind === "action" ? { click: true } : {}),
    ...(row.message_thread_id === null ? {} : { threadId: row.message_thread_id }),
    ...(createdAtMs === null ? {} : { createdAtMs }),
    ...(usageOrigin === undefined ? {} : { usageOrigin }),
    ...(row.crew_thread_id === null ? {} : { crewThreadId: row.crew_thread_id }),
    ...(scheduledOrigin === undefined ? {} : { scheduledOrigin }),
  };
};

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

// A turn that started before the window can still be running in it.
const TURN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* UsageClaims.UsageClaims;
  const register = yield* UsageSessionRegister.UsageSessionRegister;
  const store = UsageClose.makeClosedStore(sql);

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
      return entry.fmTaskId === undefined && entry.fmHome === undefined
        ? [started]
        : [{ ...started, unmatched: true }];
    });
  });

  // Columns of `thread` that say whether it is crew or a coordinator.
  const threadKind = `
    (
      json_extract(thread.payload_json, '$.crewOf') IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS root
        WHERE root.thread_id = json_extract(thread.payload_json, '$.lineage.rootThreadId')
          AND json_extract(root.payload_json, '$.crewOf') IS NOT NULL
      )
    ) AS crew,
    coalesce(json_extract(thread.payload_json, '$.coordinator') = 1, 0) AS coordinator`;

  // Columns of `message` (joined to its `thread`) that classify it and name its cause.
  const messageColumns = sql.literal(`
    message.message_id,
    message.thread_id AS message_thread_id,
    message.created_at AS message_created_at,
    message.run_id,
    json_extract(message.payload_json, '$.createdBy') AS created_by,
    json_extract(message.payload_json, '$.creationSource') AS creation_source,
    json_extract(message.payload_json, '$.origin.surface') AS surface,
    json_extract(message.payload_json, '$.origin.deviceType') AS device_type,
    json_extract(message.payload_json, '$.notification') IS NOT NULL AS notification,
    coalesce(
      json_extract(message.payload_json, '$.causedBy.messageId'),
      json_extract(thread.payload_json, '$.causedBy.messageId')
    ) AS caused_by,
    json_extract(message.payload_json, '$.causedBy.messageId') AS own_caused_by,
    json_extract(message.payload_json, '$.usageOrigin') AS usage_origin,
    json_extract(message.payload_json, '$.crewNote.threadId') AS crew_thread_id,
    json_extract(message.payload_json, '$.crewNote.kind') AS crew_note_kind,
    json_extract(message.payload_json, '$.scheduledTaskId') AS scheduled_task_id,
    ${threadKind}`);
  const fromMessages = sql.literal(`
    FROM orchestration_v2_projection_messages AS message
    LEFT JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = message.thread_id`);

  const loadScheduledOrigins = sql<{ readonly task_id: string; readonly origin_json: string }>`
    SELECT task_id, origin_json FROM usage_scheduled_task_origins
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map(
      (rows) =>
        new Map(
          rows.flatMap((row) => {
            const key = storedOriginOf(row.origin_json);
            return key === undefined ? [] : [[row.task_id, key] as const];
          }),
        ),
    ),
  );

  // Loads the recorded causes of agent prompts, one chain hop per query.
  const loadCauses = Effect.fn("UsageOrigins.loadCauses")(function* (
    messages: ReadonlyArray<CausalMessage>,
    toMessage: (row: MessageColumns) => CausalMessage,
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
        SELECT ${messageColumns} ${fromMessages}
        WHERE message.message_id IN (SELECT value FROM json_each(${encodeIds([...pending])}))
      `.pipe(NodeSqliteClient.readOnly);
      const found = rows.map(toMessage);
      for (const message of found) loaded.set(message.id, message);
      pending = causesToLoad(found);
    }
    return loaded;
  });

  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const ids = (list: Iterable<string>) => encodeIds([...new Set(list)]);

  /**
   * What places the provider turns started in [turnsSince, until) (only `onlyThread`'s, if
   * given) and the prompts since `promptsSince`: their messages, causes, claims, and the history
   * of every work thread among them or clicked on.
   */
  const collect = Effect.fn("UsageOrigins.collect")(function* (input: {
    readonly turnsSinceMs: number;
    readonly untilMs: number;
    readonly promptsSinceMs?: number;
    readonly onlyThread?: string;
  }) {
    const until = iso(input.untilMs);
    const scheduledOrigins = yield* loadScheduledOrigins;
    const toMessage = (row: MessageColumns) => messageOf(row, scheduledOrigins);
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
      WHERE turn.started_at >= ${iso(input.turnsSinceMs)} AND turn.started_at < ${until}
        ${input.onlyThread === undefined ? sql`` : sql`AND turn.thread_id = ${input.onlyThread}`}
    `.pipe(NodeSqliteClient.readOnly);
    const promptRows =
      input.promptsSinceMs === undefined
        ? []
        : yield* sql<MessageColumns>`
            SELECT ${messageColumns} ${fromMessages}
            WHERE message.role = 'user' AND message.created_at >= ${iso(input.promptsSinceMs)}
              AND message.created_at < ${until}
          `.pipe(NodeSqliteClient.readOnly);
    const turnMessages = turnRows.map((row) =>
      row.message_id === null ? null : toMessage({ ...row, message_id: row.message_id }),
    );
    const promptMessages = promptRows.map(toMessage);
    // A coordinator's typed prompts that arrive mid-turn.
    const coordinatorRunIds = turnRows.flatMap((row) =>
      row.coordinator === 1 && row.turn_run_id !== null ? [row.turn_run_id] : [],
    );
    const runPromptMessages = (
      coordinatorRunIds.length === 0
        ? []
        : yield* sql<MessageColumns>`
            SELECT ${messageColumns} ${fromMessages}
            WHERE message.role = 'user' AND message.created_at < ${until}
              AND message.run_id IN (SELECT value FROM json_each(${ids(coordinatorRunIds)}))
          `.pipe(NodeSqliteClient.readOnly)
    ).map(toMessage);
    const runPrompts = new Map<string, CausalMessage[]>();
    for (const prompt of runPromptMessages) {
      if (prompt.runId !== null) appendTo(runPrompts, prompt.runId, [prompt]);
    }

    // Work threads: those with a turn or a prompt here, and those a click was about.
    const workCandidates = new Set<string>(
      input.onlyThread === undefined ? [] : [input.onlyThread],
    );
    for (const row of turnRows) if (row.coordinator !== 1) workCandidates.add(row.thread_id);
    for (const message of [...turnMessages, ...promptMessages, ...runPromptMessages]) {
      if (message === null) continue;
      if (!message.coordinator && message.threadId !== undefined)
        workCandidates.add(message.threadId);
      if (message.click === true && message.crewThreadId !== undefined)
        workCandidates.add(message.crewThreadId);
    }
    const workRows =
      workCandidates.size === 0
        ? []
        : (yield* sql<{
            readonly thread_id: string;
            readonly created_at: string;
            readonly usage_origin: string | null;
            readonly caused_by: string | null;
            readonly crew_of: string | null;
            readonly crew: number;
            readonly coordinator: number;
          }>`
            SELECT thread.thread_id, thread.created_at,
              json_extract(thread.payload_json, '$.usageOrigin') AS usage_origin,
              json_extract(thread.payload_json, '$.causedBy.messageId') AS caused_by,
              json_extract(thread.payload_json, '$.crewOf') AS crew_of,
              ${sql.literal(threadKind)}
            FROM orchestration_v2_projection_threads AS thread
            WHERE thread.thread_id IN (SELECT value FROM json_each(${ids(workCandidates)}))
          `.pipe(NodeSqliteClient.readOnly)).filter((row) => row.coordinator !== 1);
    const workMessages = (
      workRows.length === 0
        ? []
        : yield* sql<MessageColumns>`
            SELECT ${messageColumns} ${fromMessages}
            WHERE message.role = 'user' AND message.created_at < ${until}
              AND message.thread_id IN (SELECT value FROM json_each(${ids(workRows.map((row) => row.thread_id))}))
            ORDER BY message.created_at, message.message_id
          `.pipe(NodeSqliteClient.readOnly)
    ).map(toMessage);
    // Replies typed on a work thread's box are user messages in its coordinator's chat.
    const coordinatorIds = workRows.flatMap((row) => (row.crew_of === null ? [] : [row.crew_of]));
    const replyMessages = (
      coordinatorIds.length === 0
        ? []
        : yield* sql<MessageColumns>`
            SELECT ${messageColumns} ${fromMessages}
            WHERE message.role = 'user' AND message.created_at < ${until}
              AND message.thread_id IN (SELECT value FROM json_each(${ids(coordinatorIds)}))
              AND json_extract(message.payload_json, '$.crewNote.kind') = 'reply'
          `.pipe(NodeSqliteClient.readOnly)
    ).map(toMessage);
    // An older work thread's recorded cause, as an agent prompt sent for it.
    const births = workRows.flatMap((row): CausalMessage[] =>
      row.caused_by === null
        ? []
        : [
            {
              id: `thread-birth:${row.thread_id}`,
              runId: null,
              createdBy: "agent",
              creationSource: "mcp",
              surface: "mcp",
              deviceType: "bot",
              crew: row.crew === 1,
              notification: false,
              causedBy: row.caused_by,
              coordinator: false,
            },
          ],
    );
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
            coordinator: false,
          };
    const causes = yield* loadCauses(
      [
        ...turnMessages.filter((message) => message !== null),
        ...promptMessages,
        ...runPromptMessages,
        ...workMessages,
        ...births,
        ...claimRows.flatMap((claim) => claimMessage(claim) ?? []),
      ],
      toMessage,
    );
    const causeOf = (id: string) => causes.get(id);
    const runClaims = new Map(
      claimRows.flatMap((claim) => (claim.kind === "run" ? [[claim.target, claim] as const] : [])),
    );
    const runClaimed = (runId: string) => runClaims.has(runId);
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
      const { via: _via, claim: _claim, folder: _folder, registered: _registered, ...value } = key;
      const settled = isDevice(value) ? value : undefined;
      if (cycleAt >= depth) settledRunClaims.set(runId, settled);
      cycleAt = Math.min(outerCycleAt, cycleAt < depth ? cycleAt : Number.POSITIVE_INFINITY);
      return settled;
    };
    const originOf = (message: CausalMessage) =>
      resolveMessageOrigin(message, causeOf, claimOfRun, runClaimed, (prompt) =>
        prompt.crewThreadId === undefined || prompt.createdAtMs === undefined
          ? undefined
          : startedBy(timelineOf(prompt.crewThreadId), prompt.createdAtMs)?.key,
      );
    const claimKey = (claim: UsageClaims.StoredUsageClaim): UsageOriginKey => {
      const message = claimMessage(claim);
      if (message !== null) return originOf(message);
      const origin = claim.device ?? "computer";
      // Bound by value from a thread's work when it was claimed.
      const bound = claim.bound === undefined ? undefined : boundClaimKey(origin, claim.bound);
      if (bound !== undefined) return { ...bound, via: "agent" };
      // FirstMate claims the phone for voice-journal work and the computer for upkeep.
      return {
        origin,
        basis: "claim",
        via: "agent",
        reason: origin === "phone" ? "journal" : "upkeep",
      };
    };

    const workById = new Map(workRows.map((row) => [row.thread_id, row]));
    const birthByThread = new Map(
      births.map((birth) => [birth.id.slice("thread-birth:".length), birth]),
    );
    const messagesByThread = new Map<string, CausalMessage[]>();
    for (const message of workMessages) {
      if (message.threadId !== undefined) appendTo(messagesByThread, message.threadId, [message]);
    }
    const repliesByThread = new Map<string, OriginEntry[]>();
    for (const reply of replyMessages) {
      const typed = reply.click === true ? undefined : typedOrigin(reply);
      if (typed === undefined || reply.crewThreadId === undefined) continue;
      if (reply.createdAtMs === undefined) continue;
      appendTo(repliesByThread, reply.crewThreadId, [
        {
          startedAtMs: reply.createdAtMs,
          runId: null,
          key: { origin: typed.origin, basis: typed.basis, reason: "inherited", ...rootOf(typed) },
        },
      ]);
    }
    const timelines = new Map<string, readonly OriginEntry[]>();
    const building = new Set<string>();
    const timelineOf = (threadId: string): readonly OriginEntry[] => {
      const known = timelines.get(threadId);
      if (known !== undefined) return known;
      const row = workById.get(threadId);
      // A birth that leads back to this thread while it is read counts to nothing more.
      if (row === undefined || building.has(threadId)) return [];
      building.add(threadId);
      const recordedCause = birthByThread.get(threadId);
      const recorded = recordedCause === undefined ? undefined : originOf(recordedCause);
      const birth =
        storedOriginOf(row.usage_origin) ??
        (recorded !== undefined && isDevice(recorded) ? recorded : undefined);
      const timeline = workTimeline(
        {
          createdAtMs: parseMs(row.created_at) ?? Number.NEGATIVE_INFINITY,
          ...(birth === undefined ? {} : { birth }),
          messages: messagesByThread.get(threadId) ?? [],
          replies: repliesByThread.get(threadId) ?? [],
        },
        causeOf,
      );
      building.delete(threadId);
      timelines.set(threadId, timeline);
      return timeline;
    };
    const resolver: OriginResolver = {
      causeOf,
      originOf,
      claimOfRun,
      runClaimed,
      timelineOf,
      runPrompts: (runId) => runPrompts.get(runId) ?? [],
    };

    const turns: TurnFacts[] = [];
    const worktrees = new Map<string, string>();
    turnRows.forEach((row, index) => {
      if (row.worktree_path !== null) worktrees.set(row.thread_id, row.worktree_path);
      const startedAtMs = parseMs(row.started_at);
      if (row.session_id === null || startedAtMs === null) return;
      turns.push({
        sessionId: row.session_id,
        threadId: row.thread_id,
        runId: row.turn_run_id,
        startedAtMs,
        completedAtMs: parseMs(row.completed_at),
        message: turnMessages[index] ?? null,
        coordinator: row.coordinator === 1,
      });
    });
    return { turns, worktrees, promptMessages, claimRows, claimKey, resolver };
  });

  const read = Effect.fn("UsageOrigins.read")(
    function* (sinceMs: number, untilMs: number) {
      const facts = yield* collect({
        turnsSinceMs: sinceMs - TURN_LOOKBACK_MS,
        untilMs,
        promptsSinceMs: sinceMs,
      });
      const registrations = yield* resolveRegistrations(
        yield* register.read(sinceMs - TURN_LOOKBACK_MS, untilMs),
      );
      const turns = facts.turns.flatMap((turn) => turnSegments(turn, facts.resolver));
      const workThreads = new Set(
        facts.turns.flatMap((turn) => (turn.coordinator ? [] : [turn.threadId])),
      );
      const timelines = [...workThreads].flatMap((threadId): OriginTimeline[] => {
        const entries = facts.resolver
          .timelineOf(threadId)
          .map(({ startedAtMs, key }) => ({ startedAtMs, key }));
        return entries.length === 0 ? [] : [{ threadId, entries }];
      });
      const prompts = facts.promptMessages.flatMap((message): OriginPrompt[] =>
        message.createdAtMs === undefined
          ? []
          : [
              {
                createdAtMs: message.createdAtMs,
                key: promptOrigin(message, facts.resolver),
                messageId: message.id,
                ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
              },
            ],
      );
      return {
        turns,
        prompts,
        worktrees: [...facts.worktrees].map(([threadId, directory]) => ({ threadId, directory })),
        claims: facts.claimRows.flatMap((claim): OriginClaim[] =>
          claim.kind === "run"
            ? []
            : [
                {
                  kind: claim.kind,
                  target: claim.target,
                  fromMs: claim.fromMs,
                  key: facts.claimKey(claim),
                },
              ],
        ),
        registrations,
        timelines,
      } satisfies UsageOriginSnapshot;
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  const originAt = Effect.fn("UsageOrigins.originAt")(
    function* (threadId: string, atMs: number) {
      const [thread] = yield* sql<{ readonly coordinator: number }>`
        SELECT coalesce(json_extract(payload_json, '$.coordinator') = 1, 0) AS coordinator
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `.pipe(NodeSqliteClient.readOnly);
      if (thread === undefined) return null;
      if (UsageClose.isClosed(yield* store.span, atMs)) {
        const rows = yield* store.threadLabels(threadId, atMs);
        const bound = closedBound(rows, atMs, thread.coordinator === 1);
        if (bound !== undefined) return bound;
      }
      const facts = yield* collect({
        turnsSinceMs: atMs - TURN_LOOKBACK_MS,
        untilMs: atMs + 1,
        onlyThread: threadId,
      });
      // The turn running then; a job that outlived its turn names when it began.
      const turn = startedBy(facts.turns.toSorted(byStart), atMs);
      if (
        turn !== undefined &&
        (turn.completedAtMs === null || atMs <= turn.completedAtMs + BIND_GRACE_MS)
      ) {
        const segment = startedBy(turnSegments(turn, facts.resolver), atMs);
        if (segment !== undefined)
          return {
            key: segment.key,
            reroots: segment.typed,
            runId: turn.runId,
          } satisfies BoundOrigin;
      }
      // A coordinator acting between its turns does its own upkeep.
      if (thread.coordinator === 1) return { key: NO_PROMPT_UPKEEP, reroots: false, runId: null };
      const entry = startedBy(facts.resolver.timelineOf(threadId), atMs);
      return {
        key: entry?.key ?? NO_ORIGIN_BOUND,
        reroots: false,
        runId: null,
      } satisfies BoundOrigin;
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  const bindScheduledTask = Effect.fn("UsageOrigins.bindScheduledTask")(
    function* (taskId: string, key: UsageOriginKey) {
      const boundAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO usage_scheduled_task_origins (task_id, origin_json, bound_at)
        VALUES (${taskId}, ${encodeStoredOrigin(storedOrigin(key))}, ${boundAt})
        ON CONFLICT (task_id) DO UPDATE SET
          origin_json = excluded.origin_json,
          bound_at = excluded.bound_at
      `;
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  const closedSpan = store.span.pipe(
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  const readClosed = Effect.fn("UsageOrigins.readClosed")(
    function* (input: {
      readonly span: UsageClose.ClosedSpan;
      readonly sessionIds: readonly string[];
      readonly sinceMs: number;
      readonly untilMs: number;
    }) {
      const [rows, prompts] = yield* Effect.all([
        store.sessionLabels(input.sessionIds, input.span.throughMs),
        store.promptLabels(
          Math.max(input.sinceMs, input.span.fromMs),
          Math.min(input.untilMs, input.span.throughMs + 1),
        ),
      ]);
      return { labels: new UsageClose.ClosedLabels(rows), prompts };
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  const close = Effect.fn("UsageOrigins.close")(
    function* (throughMs: number, records: readonly OriginRecord[]) {
      const span = yield* store.span;
      const afterMs = span?.throughMs ?? UsageClose.CLOSE_FROM_MS - 1;
      if (throughMs <= afterMs) return { closed: false, why: "notDue" } satisfies CloseOutcome;
      const inSpan = (atMs: number) => atMs > afterMs && atMs <= throughMs;
      const snapshot = yield* read(afterMs + 1, throughMs + 1);
      const index = new UsageOriginIndex(snapshot);
      const closing = records.filter((record) => inSpan(record.timestampMs));
      const sessions = UsageClose.closedSessionLabels(
        index,
        snapshot.turns,
        closing,
        afterMs,
        throughMs,
      );
      const prompts = snapshot.prompts.flatMap((prompt): UsageClose.ClosedPromptLabel[] =>
        prompt.messageId === undefined || !inSpan(prompt.createdAtMs)
          ? []
          : [{ ...prompt, messageId: prompt.messageId }],
      );
      const next = { fromMs: span?.fromMs ?? UsageClose.CLOSE_FROM_MS, throughMs };
      const closedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* store.span;
            if ((current?.throughMs ?? UsageClose.CLOSE_FROM_MS - 1) !== afterMs)
              return yield* new UsageClose.CloseSuperseded();
            yield* store.write({ span: next, closedAt, sessions, prompts });
            // Read back through the stored rows, as the reader will.
            const sessionIds = [...new Set(closing.map((record) => record.sessionId))];
            const stored = new UsageClose.ClosedLabels(
              yield* store.sessionLabels(sessionIds, throughMs),
            );
            const differing = UsageClose.differingRecords(stored, index, closing).length;
            const storedPrompts = new Map(
              (yield* store.promptLabels(afterMs + 1, throughMs + 1)).map((prompt) => [
                prompt.messageId,
                prompt.key,
              ]),
            );
            const differingPrompts =
              prompts.filter(
                (prompt) => !UsageClose.sameKey(storedPrompts.get(prompt.messageId), prompt.key),
              ).length + Math.abs(storedPrompts.size - prompts.length);
            if (differing > 0 || differingPrompts > 0)
              return yield* new UsageClose.ClosedLabelsDiffer({
                records: differing,
                prompts: differingPrompts,
              });
            return {
              closed: true,
              span: next,
              records: closing.length,
              sessionRows: sessions.length,
              promptRows: prompts.length,
            } satisfies CloseOutcome;
          }),
        )
        .pipe(
          Effect.catchTags({
            CloseSuperseded: () =>
              Effect.succeed({ closed: false, why: "superseded" } satisfies CloseOutcome),
            ClosedLabelsDiffer: (error) =>
              Effect.logWarning(error.message, { throughMs }).pipe(
                Effect.as({ closed: false, why: "differs" } satisfies CloseOutcome),
              ),
          }),
        );
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  return UsageOrigins.of({
    read,
    originAt,
    bindScheduledTask,
    closedSpan,
    readClosed,
    close,
  });
});

export const layer = Layer.effect(UsageOrigins, make);

/** For tests of the tools that bind origins: binds nothing. */
export const layerTest = Layer.mock(UsageOrigins)({
  originAt: () => Effect.succeed(null),
  bindScheduledTask: () => Effect.void,
});
