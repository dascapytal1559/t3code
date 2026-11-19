import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClaims from "./UsageClaims.ts";
import * as UsageClose from "./UsageClose.ts";
import * as UsageLabels from "./UsageLabels.ts";
import * as UsageLabelStore from "./UsageLabelStore.ts";
import * as UsageOrigins from "./UsageOrigins.ts";
import * as UsageSessionRegister from "./UsageSessionRegister.ts";
import { seedMessage, seedRun, seedThread } from "./usageOriginsTestSeed.ts";

const phone = {
  createdBy: "user",
  creationSource: "web",
  origin: { surface: "web", deviceType: "mobile" },
};
const computer = { ...phone, origin: { surface: "desktop", deviceType: "desktop" } };
const fromMcp = {
  createdBy: "agent",
  creationSource: "mcp",
  origin: { surface: "mcp", deviceType: "bot" },
};
const wake = {
  createdBy: "agent",
  creationSource: "provider",
  notification: { source: { kind: "background_task" }, outcome: "completed" },
};
// After T3 began recording devices, where born labels can start.
const iso = (clock: string) => `2026-11-20T${clock.length === 5 ? `${clock}:00` : clock}.000Z`;
const time = (clock: string) => Date.parse(iso(clock));
const clockOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(11, 23);

const layerWith = (registrations: readonly UsageSessionRegister.SessionRegistration[]) =>
  UsageLabels.layer.pipe(
    Layer.provideMerge(
      UsageOrigins.layer.pipe(
        Layer.provide(
          Layer.mock(UsageSessionRegister.UsageSessionRegister)({
            read: (fromMs, untilMs) =>
              Effect.succeed(
                registrations.filter(
                  (entry) => entry.startedAtMs >= fromMs && entry.startedAtMs < untilMs,
                ),
              ),
          }),
        ),
      ),
    ),
    Layer.provideMerge(UsageClaims.layer),
    Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
  );

/** A turn started and running; `finish` ends it. */
const start = (id: string, ordinal: number, threadId: string, from: string, message: object) =>
  seedRun({
    id,
    ordinal,
    threadId,
    sessionId: `${threadId}-session`,
    startedAt: iso(from),
    message: { ...message },
  });
const finish = (id: string, clock: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_turns SET completed_at = ${iso(clock)}
      WHERE provider_turn_id = ${`turn-${id}`}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET completed_at = ${iso(clock)}
      WHERE run_id = ${`run-${id}`}
    `;
  });

const labelling = Effect.gen(function* () {
  const labels = yield* UsageLabels.UsageLabels;
  const origins = yield* UsageOrigins.UsageOrigins;
  const claims = yield* UsageClaims.UsageClaims;
  const store = UsageLabelStore.makeLabelStore(yield* SqlClient.SqlClient);
  /** A pass as the reactor runs one, just after something happened. */
  const passAt = (clock: string) =>
    TestClock.setTime(time(clock)).pipe(Effect.andThen(labels.catchUp));
  const summary = (key: UsageOrigins.UsageOriginKey) =>
    [
      key.origin,
      key.reason,
      ...(key.claim === undefined ? [] : [`${key.claim} claim`]),
      ...(key.registered === true ? ["registered"] : []),
      ...(key.root === undefined ? [] : [key.root.messageId]),
    ].join(" ");
  const rowsOf = (sessionId: string) =>
    store
      .sessionLabels([sessionId], Number.MAX_SAFE_INTEGER)
      .pipe(
        Effect.map((rows) =>
          rows
            .toSorted((a, b) => a.fromMs - b.fromMs)
            .map((row) => `${clockOf(row.fromMs)} ${summary(row.key)}`),
        ),
      );
  const promptOf = (messageId: string) =>
    store
      .promptLabels(0, Number.MAX_SAFE_INTEGER)
      .pipe(
        Effect.map((prompts) =>
          prompts.flatMap((prompt) =>
            prompt.messageId === messageId ? [summary(prompt.key)] : [],
          ),
        ),
      );
  /** Each record's born label against the live reader's, as the close compares them. */
  const differing = (records: readonly UsageOrigins.OriginRecord[]) =>
    Effect.gen(function* () {
      const live = new UsageOrigins.UsageOriginIndex(
        yield* origins.read(time("00:00"), time("23:59")),
      );
      const born = new UsageClose.ClosedLabels(
        yield* store.sessionLabels(
          records.map((record) => record.sessionId),
          Number.MAX_SAFE_INTEGER,
        ),
      );
      return records.flatMap((record) => {
        const derived = live.lookup(record);
        const stored = born.labelAt(record);
        return UsageClose.sameKey(derived, stored)
          ? []
          : [
              `${record.sessionId} ${clockOf(record.timestampMs)}: ${summary(derived)} / ${
                stored === undefined ? "none" : summary(stored)
              }`,
            ];
      });
    });
  return { labels, origins, claims, passAt, rowsOf, promptOf, differing };
});

describe("UsageLabels", () => {
  it.effect("writes each label as the event that decides it happens, as Usage reads it", () =>
    Effect.gen(function* () {
      const { origins, passAt, rowsOf, differing } = yield* labelling;
      yield* seedThread({ id: "firstmate", coordinator: true });

      // A turn typed on the phone.
      yield* start("fm-phone", 1, "firstmate", "01:00", phone);
      yield* passAt("01:00:01");
      assert.deepStrictEqual(yield* rowsOf("firstmate-session"), [
        "01:00:00.000 phone typed message-fm-phone",
      ]);

      // A launch from it: the worker is born where that turn counts.
      const launch = yield* origins.originAt("firstmate", time("01:01"));
      yield* seedThread({
        id: "worker",
        crewOf: "firstmate",
        createdAt: iso("01:01"),
        usageOrigin: UsageOrigins.storedOrigin(launch!.key, launch!.atMs),
      });
      yield* start("w1", 1, "worker", "01:01", fromMcp);
      yield* passAt("01:01:02");
      assert.deepStrictEqual(yield* rowsOf("worker-session"), [
        "01:01:00.000 phone inherited message-fm-phone",
      ]);

      // A review the worker starts outside T3 registers from it.
      yield* passAt("01:20:05");
      assert.deepStrictEqual(yield* rowsOf("review-session"), [
        "01:20:00.000 phone inherited registered message-fm-phone",
      ]);

      // A prompt typed on the computer mid-turn splits the turn there.
      yield* seedMessage({
        id: "fm-steer",
        threadId: "firstmate",
        runId: "run-fm-phone",
        createdAt: iso("01:25"),
        payload: computer,
      });
      yield* passAt("01:25:01");
      yield* finish("fm-phone", "01:28");
      yield* finish("w1", "01:30");
      yield* passAt("01:31");
      assert.deepStrictEqual(yield* rowsOf("firstmate-session"), [
        "01:00:00.000 phone typed message-fm-phone",
        "01:25:00.000 computer typed fm-steer",
        // Its end, after which nothing runs in it.
        "01:28:00.001 computer typed fm-steer",
      ]);

      // A reply typed on the worker's box between its turns moves its work, and the review.
      yield* start("fm-reply", 2, "firstmate", "02:00", {
        ...computer,
        crewNote: { threadId: "worker", kind: "reply" },
      });
      yield* passAt("02:00:01");
      yield* finish("fm-reply", "02:02");
      assert.deepStrictEqual(yield* rowsOf("worker-session"), [
        "01:01:00.000 phone inherited message-fm-phone",
        "01:30:00.001 phone inherited message-fm-phone",
        "02:00:00.000 computer inherited message-fm-reply",
      ]);
      assert.deepStrictEqual(yield* rowsOf("review-session"), [
        "01:20:00.000 phone inherited registered message-fm-phone",
        "02:00:00.000 computer inherited registered message-fm-reply",
      ]);

      // An upkeep launch counts to the computer, though the turn that launched it was typed.
      yield* start("fm-goodnight", 3, "firstmate", "03:00", phone);
      yield* seedThread({
        id: "routine",
        crewOf: "firstmate",
        createdAt: iso("03:01"),
        usageOrigin: UsageOrigins.storedOrigin(UsageOrigins.LAUNCHED_UPKEEP),
      });
      yield* start("routine-1", 1, "routine", "03:01", fromMcp);
      yield* passAt("03:01:02");
      yield* finish("fm-goodnight", "03:05");
      yield* finish("routine-1", "03:20");
      // A pass well after the last: the settle window is passed, and nothing is lost.
      yield* passAt("04:00");
      assert.deepStrictEqual(yield* rowsOf("routine-session"), [
        "03:01:00.000 computer upkeep",
        "03:20:00.001 computer upkeep",
      ]);
      // A session registered from a thread this server does not have is labelled all the same.
      assert.deepStrictEqual(yield* rowsOf("elsewhere-session"), [
        "01:40:00.000 unknown unmatchedRegistration",
      ]);

      // Every record counts where Usage's own reader says.
      const records = [
        ["firstmate-session", ["01:05", "01:26", "01:40", "03:02"]],
        ["worker-session", ["01:10", "01:45", "02:30"]],
        ["review-session", ["01:21", "01:59", "02:01"]],
        ["routine-session", ["03:10", "03:30"]],
        ["elsewhere-session", ["01:41", "03:00"]],
      ].flatMap(([sessionId, clocks]) =>
        (clocks as string[]).map((clock) => ({
          sessionId: sessionId as string,
          timestampMs: time(clock),
        })),
      );
      assert.deepStrictEqual(yield* differing(records), []);
      // And the close, sealing them, finds the born labels the same.
      yield* TestClock.setTime(time("23:59"));
      const closed = yield* origins.close(time("12:00"), records);
      assert.deepStrictEqual(closed.closed ? closed.born : closed, {
        records: records.length,
        differingRecords: 0,
        prompts: 6,
        differingPrompts: 0,
        byReason: {},
      });
    }).pipe(
      Effect.provide(
        layerWith([
          {
            sessionId: "review-session",
            startedAtMs: time("01:20"),
            provider: "codex",
            threadId: "worker",
          },
          {
            sessionId: "elsewhere-session",
            startedAtMs: time("01:40"),
            provider: "codex",
            threadId: "another-environments-thread",
          },
        ]),
      ),
    ),
  );

  it.effect("names a wake while it runs, and refuses a name given after it ended", () =>
    Effect.gen(function* () {
      const { labels, origins, claims, passAt, rowsOf, promptOf, differing } = yield* labelling;
      yield* seedThread({ id: "firstmate", coordinator: true });
      yield* seedThread({ id: "task", crewOf: "firstmate", createdAt: iso("00:30") });
      yield* start("task-1", 1, "task", "00:30", phone);
      yield* finish("task-1", "00:40");

      // A wake is upkeep until FirstMate's drain names it, three seconds in, for the task.
      yield* start("fm-wake", 1, "firstmate", "04:00", wake);
      yield* passAt("04:00:01");
      assert.deepStrictEqual(yield* rowsOf("firstmate-session"), ["04:00:00.000 computer upkeep"]);
      yield* TestClock.setTime(time("04:00:03"));
      const bound = yield* origins.originAt("task", time("04:00:03"));
      const { origin, ...binding } = UsageOrigins.storedOrigin(bound!.key, bound!.atMs)!;
      yield* claims.claim({
        target: { kind: "run", runId: "run-fm-wake" },
        value: { device: origin as "phone", bound: binding },
      });
      assert.strictEqual(yield* labels.named("run-fm-wake"), "written");
      assert.deepStrictEqual(yield* rowsOf("firstmate-session"), [
        "04:00:00.000 phone inherited run claim message-task-1",
      ]);
      assert.deepStrictEqual(yield* promptOf("message-fm-wake"), [
        "phone inherited run claim message-task-1",
      ]);
      yield* finish("fm-wake", "04:10");

      // The voice journal's wake: the drain names it the phone.
      yield* start("fm-journal", 2, "firstmate", "05:00", wake);
      yield* passAt("05:00:01");
      yield* TestClock.setTime(time("05:00:02"));
      yield* claims.claim({
        target: { kind: "run", runId: "run-fm-journal" },
        value: { device: "phone" },
      });
      assert.strictEqual(yield* labels.named("run-fm-journal"), "written");
      yield* finish("fm-journal", "05:05");

      // A name given after a wake ended changes nothing it was born with, now or in later passes.
      yield* start("fm-late", 3, "firstmate", "06:00", wake);
      yield* passAt("06:00:01");
      yield* finish("fm-late", "06:10");
      yield* passAt("06:11");
      yield* TestClock.setTime(time("06:20"));
      yield* claims.claim({
        target: { kind: "run", runId: "run-fm-late" },
        value: { device: "phone" },
      });
      assert.strictEqual(yield* labels.named("run-fm-late"), "refused");
      yield* passAt("06:21");
      assert.deepStrictEqual(yield* rowsOf("firstmate-session"), [
        "04:00:00.000 phone inherited run claim message-task-1",
        "04:10:00.001 phone inherited run claim message-task-1",
        "05:00:00.000 phone journal run claim",
        "05:05:00.001 phone journal run claim",
        "06:00:00.000 computer upkeep",
        "06:10:00.001 computer upkeep",
      ]);

      // The live reader takes the late name; the close counts that difference by its reasons.
      const records = ["04:05", "05:02", "06:05"].map((clock) => ({
        sessionId: "firstmate-session",
        timestampMs: time(clock),
      }));
      assert.deepStrictEqual(yield* differing(records), [
        "firstmate-session 06:05:00.000: phone journal run claim / computer upkeep",
      ]);
      yield* TestClock.setTime(time("23:59"));
      const closed = yield* origins.close(time("12:00"), records);
      assert.deepStrictEqual(closed.closed ? closed.born : closed, {
        records: 3,
        differingRecords: 1,
        prompts: 4,
        differingPrompts: 1,
        byReason: {
          "record: phone journal run claim -> computer upkeep": 1,
          "prompt: phone journal run claim -> computer upkeep": 1,
        },
      });
    }).pipe(Effect.provide(layerWith([]))),
  );
});
