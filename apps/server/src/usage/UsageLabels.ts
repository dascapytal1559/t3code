import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageClose from "./UsageClose.ts";
import * as UsageLabelStore from "./UsageLabelStore.ts";
import * as UsageOrigins from "./UsageOrigins.ts";

// The windows Usage reads origins with: a turn running into the window, a session outside T3.
const TURN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const REGISTER_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

/** What one pass wrote. */
export interface LabelPass {
  readonly afterMs: number;
  readonly throughMs: number;
  readonly threads: number;
}

/**
 * Usage labels written when the event that decides them happens, alongside the daily close, which
 * checks them: a turn starting, work moving, a running turn named, a session registering, a prompt
 * arriving. Each pass writes what changed since the last, by the rules Usage reads with.
 */
export class UsageLabels extends Context.Service<
  UsageLabels,
  {
    /** Writes every label decided since the last pass; the first starts where the close's rows end. */
    readonly catchUp: Effect.Effect<LabelPass, UsageOrigins.UsageOriginsReadError>;
    /**
     * A running turn was named: its thread's labels since the turn began are written again. A run
     * that already ended keeps its labels (`refused`).
     */
    readonly named: (
      runId: string,
    ) => Effect.Effect<"written" | "refused" | "unknown", UsageOrigins.UsageOriginsReadError>;
  }
>()("t3/usage/UsageLabels") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const origins = yield* UsageOrigins.UsageOrigins;
  const store = UsageLabelStore.makeLabelStore(sql);
  const lock = yield* Semaphore.make(1);
  // Threads a pass could not label, from when: the next passes label them again until one works.
  const retry = new Map<string, number>();
  const readError = (cause: unknown) => new UsageOrigins.UsageOriginsReadError({ cause });

  /** Rewrites a thread's labels after `afterMs`: its sessions', its prompts' and its work's. */
  const labelThread = Effect.fn("UsageLabels.labelThread")(function* (input: {
    readonly threadId: string;
    readonly afterMs: number;
    readonly throughMs: number;
    readonly registrations: readonly UsageOrigins.OriginRegistration[];
  }) {
    const labels = yield* origins.labelThread(input);
    if (labels === null) return false;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const session of labels.sessions) {
          const lastMs = Math.min(input.throughMs, session.untilMs - 1);
          const previous =
            session.startedAtMs > input.afterMs
              ? undefined
              : yield* store.latestLabel(session.sessionId, input.afterMs, session.startedAtMs);
          // A session with no label yet is labelled from its start; one registered again, only
          // from that registration on.
          const afterMs =
            previous === undefined && session.startedAtMs <= input.afterMs
              ? session.startedAtMs - 1
              : Math.max(input.afterMs, session.startedAtMs - 1);
          const rows = labels.rowsAfter(session, afterMs);
          const first = rows[0];
          const fresh =
            previous !== undefined && first !== undefined && UsageClose.sameRow(previous, first)
              ? rows.slice(1)
              : rows;
          yield* store.replaceSessionRows(session.sessionId, afterMs, lastMs, fresh);
        }
        yield* store.writePrompts(labels.prompts);
        yield* store.writeWork(input.threadId, labels.work, input.afterMs);
      }),
    );
    return true;
  });

  /** A registration naming no thread T3 knows counts as it was registered, from its start. */
  const registeredAlone = (registration: UsageOrigins.OriginRegistration) => ({
    sessionId: registration.sessionId,
    fromMs: registration.startedAtMs,
    key:
      registration.unmatched === true || registration.threadId !== undefined
        ? UsageOrigins.UNMATCHED_REGISTRATION
        : UsageOrigins.TERMINAL_ORIGIN,
    runId: null,
    typed: false,
  });

  /** Every registration of the sessions registered from each thread, by thread. */
  const registrationsByThread = (registrations: readonly UsageOrigins.OriginRegistration[]) => {
    const sessionsOf = new Map<string, Set<string>>();
    for (const entry of registrations) {
      if (entry.threadId === undefined) continue;
      const sessions = sessionsOf.get(entry.threadId) ?? new Set<string>();
      sessions.add(entry.sessionId);
      sessionsOf.set(entry.threadId, sessions);
    }
    return (threadId: string) => {
      const sessions = sessionsOf.get(threadId);
      return sessions === undefined
        ? []
        : registrations.filter((entry) => sessions.has(entry.sessionId));
    };
  };

  const pass = Effect.fn("UsageLabels.pass")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cursor = yield* store.cursor;
    // Labels begin where the close's rows end, so the next close checks every record it seals.
    const fromMs =
      cursor?.fromMs ?? (yield* origins.closedSpan)?.throughMs ?? UsageClose.CLOSE_FROM_MS - 1;
    const afterMs =
      cursor === null ? fromMs : Math.max(fromMs, cursor.throughMs - UsageClose.SETTLE_MS);
    const threads = new Map<string, number>();
    const include = (threadId: string, sinceMs: number) =>
      threads.set(threadId, Math.min(threads.get(threadId) ?? sinceMs, sinceMs));
    for (const threadId of yield* store.activeThreads({
      afterMs,
      throughMs: nowMs,
      // The first pass also labels sessions whose turns began before it and run on.
      turnsAfterMs: cursor === null ? afterMs - TURN_LOOKBACK_MS : afterMs,
    }))
      include(threadId, afterMs);
    for (const named of yield* store.namedRuns(afterMs, nowMs))
      include(named.threadId, named.startedAtMs - 1);
    for (const [threadId, sinceMs] of retry) include(threadId, sinceMs);
    const registrations = yield* origins.registrations(afterMs - REGISTER_LOOKBACK_MS, nowMs + 1);
    const pending = yield* store.unlabelled(registrations);
    for (const registration of pending)
      if (registration.threadId !== undefined) include(registration.threadId, afterMs);
    const unknownThreads = new Set<string>();
    const registrationsOf = registrationsByThread(registrations);
    for (const [threadId, sinceMs] of threads) {
      const known = yield* labelThread({
        threadId,
        afterMs: sinceMs,
        throughMs: nowMs,
        registrations: registrationsOf(threadId),
      }).pipe(
        Effect.tap(() => Effect.sync(() => retry.delete(threadId))),
        Effect.catch((cause) =>
          Effect.logWarning("Usage could not write a thread's labels", { threadId, cause }).pipe(
            Effect.andThen(Effect.sync(() => retry.set(threadId, sinceMs))),
            Effect.as(true),
          ),
        ),
      );
      if (!known) unknownThreads.add(threadId);
    }
    const alone = pending.filter(
      (entry) => entry.threadId === undefined || unknownThreads.has(entry.threadId),
    );
    if (alone.length > 0)
      yield* sql.withTransaction(
        Effect.forEach(
          alone,
          (entry) =>
            store.replaceSessionRows(entry.sessionId, entry.startedAtMs - 1, entry.startedAtMs, [
              registeredAlone(entry),
            ]),
          { discard: true },
        ),
      );
    yield* store.setCursor(
      { fromMs, throughMs: nowMs },
      DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    );
    return { afterMs, throughMs: nowMs, threads: threads.size } satisfies LabelPass;
  });

  const catchUp = pass().pipe(
    lock.withPermits(1),
    Effect.mapError((cause) => (cause._tag === "UsageOriginsReadError" ? cause : readError(cause))),
  );

  const named = Effect.fn("UsageLabels.named")(
    function* (runId: string) {
      const run = yield* store.run(runId);
      if (run === undefined) return "unknown" as const;
      // A name given after the work ended would be a label changed after the fact.
      if (run.ended) return "refused" as const;
      const nowMs = yield* Clock.currentTimeMillis;
      const cursor = yield* store.cursor;
      // Before labels are written at all, the first pass writes this turn's with the rest.
      if (cursor === null) return "written" as const;
      const registrations = yield* origins.registrations(
        run.startedAtMs - REGISTER_LOOKBACK_MS,
        nowMs + 1,
      );
      yield* labelThread({
        threadId: run.threadId,
        afterMs: Math.max(cursor.fromMs, run.startedAtMs - 1),
        throughMs: nowMs,
        registrations: registrationsByThread(registrations)(run.threadId),
      });
      return "written" as const;
    },
    lock.withPermits(1),
    Effect.mapError((cause) => (cause._tag === "UsageOriginsReadError" ? cause : readError(cause))),
  );

  return UsageLabels.of({ catchUp, named });
});

export const layer = Layer.effect(UsageLabels, make);

// What can decide a label: a thread created, a prompt, a run or a provider turn starting or ending.
const LABEL_EVENTS: ReadonlySet<string> = new Set([
  "thread.created",
  "message.updated",
  "run.created",
  "run.updated",
  "provider-turn.updated",
]);
/** Passes run at most this often; a burst of events makes one. */
const PASS_SPACING = "5 seconds";
/** Sessions register in a file, with no event to wake on. */
const REGISTER_POLL = "5 minutes";

/** Catches up at start, then writes labels after the events that decide them. */
export const layerReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const labels = yield* UsageLabels;
    const engine = yield* Orchestrator.OrchestratorV2;
    const wakes = Stream.mergeAll(
      [
        Stream.make(undefined),
        engine.streamDomainEvents.pipe(
          Stream.filter((event) => LABEL_EVENTS.has(event.type)),
          Stream.catchCause((cause) =>
            Stream.fromEffect(Effect.logWarning("Usage labels stopped hearing events", cause)),
          ),
        ),
        Stream.tick(REGISTER_POLL),
      ],
      { concurrency: "unbounded" },
    );
    yield* forkParked(
      wakes.pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() =>
          labels.catchUp.pipe(
            Effect.catchCause((cause) => Effect.logWarning("Usage could not write labels", cause)),
            Effect.andThen(Effect.sleep(PASS_SPACING)),
          ),
        ),
      ),
    );
  }),
);
