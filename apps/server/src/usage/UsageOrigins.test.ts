import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { MessageId, ThreadId, USAGE_ORIGINS_RECORDED_SINCE } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClaims from "./UsageClaims.ts";
import {
  classifyMessageOrigin,
  layer as usageOriginsLayer,
  MAX_CAUSE_DEPTH,
  resolveMessageOrigin,
  settleOrigin,
  UsageOriginIndex,
  UsageOrigins,
  type CausalMessage,
  type OriginMessage,
} from "./UsageOrigins.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const message = (overrides: Partial<OriginMessage>): OriginMessage => ({
  createdBy: "user",
  creationSource: "web",
  surface: null,
  deviceType: null,
  crew: false,
  notification: false,
  ...overrides,
});

const causal = (id: string, overrides: Partial<CausalMessage>): CausalMessage => ({
  ...message(overrides),
  id,
  runId: overrides.runId ?? null,
  causedBy: overrides.causedBy ?? null,
});

const messages = (list: ReadonlyArray<CausalMessage>) => {
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  return (id: string) => byId.get(id);
};

describe("classifyMessageOrigin", () => {
  it("buckets stamps by device and leaves older messages unknown unless their creation says more", () => {
    const cases: ReadonlyArray<readonly [Partial<OriginMessage>, string]> = [
      [{ surface: "web", deviceType: "mobile" }, "phone/stamp"],
      [{ surface: "web", deviceType: "tablet" }, "phone/stamp"],
      [{ creationSource: "mobile", surface: "mobile", deviceType: "mobile" }, "phone/stamp"],
      [{ surface: "desktop", deviceType: "desktop" }, "computer/stamp"],
      [{ surface: "web", deviceType: "desktop" }, "computer/stamp"],
      [{ surface: "web", deviceType: "unknown" }, "unknown/stamp"],
      [
        { createdBy: "agent", creationSource: "mcp", surface: "mcp", deviceType: "bot" },
        "agent/stamp",
      ],
      [{ creationSource: "mobile" }, "phone/nativeApp"],
      [{ createdBy: "agent", creationSource: "mcp" }, "agent/sender"],
      [{ createdBy: "agent", creationSource: "provider" }, "agent/sender"],
      [{ createdBy: "agent", creationSource: "server" }, "agent/sender"],
      // Background-task updates the provider posts never carry a stamp.
      [
        { createdBy: "agent", creationSource: "provider", notification: true },
        "agent/notification",
      ],
      [{ createdBy: "agent", creationSource: "server", notification: true }, "agent/notification"],
      [{ crew: true, createdBy: "agent", notification: true }, "crew/notification"],
      [{ creationSource: "web" }, "unknown/unstamped"],
      [{ creationSource: "server" }, "unknown/server"],
      [{ createdBy: null, creationSource: null }, "unknown/unstamped"],
      [{ crew: true, createdBy: "agent", creationSource: "mcp" }, "crew/sender"],
      [{ crew: true, surface: "mcp", deviceType: "bot" }, "crew/stamp"],
      // A prompt the captain types into a crew thread is still his device's.
      [{ crew: true, surface: "web", deviceType: "mobile" }, "phone/stamp"],
      [{ crew: true, creationSource: "web" }, "unknown/unstamped"],
    ];
    for (const [input, expected] of cases) {
      const { origin, basis } = classifyMessageOrigin(message(input));
      assert.strictEqual(`${origin}/${basis}`, expected, JSON.stringify(input));
    }
  });
});

describe("resolveMessageOrigin", () => {
  const phone = causal("phone", { surface: "web", deviceType: "mobile" });
  const computer = causal("computer", { surface: "desktop", deviceType: "desktop" });
  const fromMcp = { createdBy: "agent", creationSource: "mcp", surface: "mcp", deviceType: "bot" };

  it("counts an agent prompt to the phone or computer prompt at the root of its causes", () => {
    const lead = causal("lead", { ...fromMcp, causedBy: "phone" });
    const brief = causal("brief", { ...fromMcp, crew: true, causedBy: "lead" });
    const direct = causal("direct", { ...fromMcp, causedBy: "computer" });
    const byId = messages([phone, computer, lead, brief, direct]);
    assert.deepStrictEqual(resolveMessageOrigin(brief, byId), {
      origin: "phone",
      basis: "stamp",
      via: "crew",
    });
    assert.deepStrictEqual(resolveMessageOrigin(direct, byId), {
      origin: "computer",
      basis: "stamp",
      via: "agent",
    });
    // A human prompt is a root even if something named a cause for it.
    const typed = causal("typed", { surface: "web", deviceType: "desktop", causedBy: "phone" });
    assert.deepStrictEqual(resolveMessageOrigin(typed, byId), {
      origin: "computer",
      basis: "stamp",
    });
  });

  it("keeps the prompt's own origin when its chain is missing, cyclic, too deep or not a device's", () => {
    const missing = causal("missing", { ...fromMcp, crew: true, causedBy: "deleted" });
    const left = causal("left", { ...fromMcp, causedBy: "right" });
    const right = causal("right", { ...fromMcp, causedBy: "left" });
    const scheduled = causal("scheduled", { createdBy: "user", creationSource: "server" });
    const fromServer = causal("from-server", { ...fromMcp, crew: true, causedBy: "scheduled" });
    const uncaused = causal("uncaused", { ...fromMcp, crew: true });
    const hops = Array.from({ length: MAX_CAUSE_DEPTH + 1 }, (_, index) =>
      causal(`hop-${index}`, { ...fromMcp, causedBy: index === 0 ? "phone" : `hop-${index - 1}` }),
    );
    const byId = messages([phone, missing, left, right, scheduled, fromServer, uncaused, ...hops]);
    const crew = { origin: "crew", basis: "stamp" };
    assert.deepStrictEqual(resolveMessageOrigin(missing, byId), crew);
    assert.deepStrictEqual(resolveMessageOrigin(left, byId), { origin: "agent", basis: "stamp" });
    assert.deepStrictEqual(resolveMessageOrigin(fromServer, byId), crew);
    assert.deepStrictEqual(resolveMessageOrigin(uncaused, byId), crew);
    // MAX_CAUSE_DEPTH hops reach the phone; one more does not.
    assert.deepStrictEqual(resolveMessageOrigin(hops[MAX_CAUSE_DEPTH - 1]!, byId), {
      origin: "phone",
      basis: "stamp",
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(hops[MAX_CAUSE_DEPTH]!, byId), {
      origin: "agent",
      basis: "stamp",
    });
  });

  describe("UsageOriginIndex", () => {
    it("credits a record to its session's turn running at the time", () => {
      const phone = { origin: "phone", basis: "stamp" } as const;
      const agent = { origin: "agent", basis: "stamp" } as const;
      const index = new UsageOriginIndex({
        turns: [
          { sessionId: "s", threadId: "t", startedAtMs: 2_000, completedAtMs: null, key: agent },
          { sessionId: "s", threadId: "t", startedAtMs: 1_000, completedAtMs: 1_500, key: phone },
        ],
        worktrees: [],
        claims: [],
      });
      const at = (sessionId: string, timestampMs: number) =>
        index.lookup({ sessionId, timestampMs });
      assert.strictEqual(at("s", 999), null);
      assert.deepStrictEqual(at("s", 1_000), phone);
      // Late records within the grace still belong to the finished turn.
      assert.deepStrictEqual(at("s", 1_900), phone);
      assert.deepStrictEqual(at("s", 2_000), agent);
      assert.deepStrictEqual(at("s", 10 * 60 * 1000), agent);
      assert.strictEqual(at("other", 1_200), null);
    });

    it("credits sessions outside T3 by claim, then by the folder they ran in", () => {
      const phone = { origin: "phone", basis: "stamp" } as const;
      const computer = { origin: "computer", basis: "stamp" } as const;
      const claimed = { origin: "phone", basis: "stamp", via: "agent" } as const;
      const late = 1_000 + 6 * 60 * 1000;
      const index = new UsageOriginIndex({
        turns: [
          {
            sessionId: "lead",
            threadId: "lead-thread",
            startedAtMs: 0,
            completedAtMs: 1_000,
            key: phone,
          },
          { sessionId: "w1", threadId: "worker", startedAtMs: 0, completedAtMs: 1_000, key: phone },
          {
            sessionId: "w2",
            threadId: "worker",
            startedAtMs: 5_000,
            completedAtMs: 6_000,
            key: computer,
          },
          {
            sessionId: "next",
            threadId: "next-worker",
            startedAtMs: 20_000,
            completedAtMs: null,
            key: claimed,
          },
        ],
        // The slot is reused by a later worker.
        worktrees: [
          { threadId: "worker", directory: "/wt/worker" },
          { threadId: "next-worker", directory: "/wt/worker" },
        ],
        claims: [
          { kind: "session", target: "pipeline-session", key: claimed },
          { kind: "directory", target: "/runs/pipeline", key: claimed },
          { kind: "directory", target: "/wt/worker/nested", key: claimed },
        ],
      });
      const at = (sessionId: string, timestampMs: number, cwd?: string) =>
        index.lookup({ sessionId, timestampMs, cwd });
      assert.deepStrictEqual(at("pipeline-session", 9_000), claimed);
      assert.deepStrictEqual(at("cli", 9_000, "/runs/pipeline/review"), claimed);
      assert.strictEqual(at("cli", 9_000, "/runs/pipeline-other"), null);
      // A child run in a thread's worktree counts to that thread's latest turn by then.
      assert.deepStrictEqual(at("cli", 2_000, "/wt/worker/backtest"), phone);
      assert.deepStrictEqual(at("cli", 7_000, "/wt/worker"), computer);
      assert.deepStrictEqual(at("cli", 21_000, "/wt/worker"), claimed);
      assert.strictEqual(at("cli", -1, "/wt/worker"), null);
      // The deepest folder wins.
      assert.deepStrictEqual(at("cli", 7_000, "/wt/worker/nested/x"), claimed);
      // Claude names a session's scratchpad folder for the session.
      assert.deepStrictEqual(at("grok", late, "/tmp/claude-501/-proj/lead/scratchpad"), phone);
      // A terminal resume of a T3 session long after its turn ended is not T3's, even in its worktree.
      assert.strictEqual(at("w2", 6_000 + 6 * 60 * 1000, "/wt/worker"), null);
    });
  });

  it("ends an uncaused or unknown chain at the device its prompt's run was claimed for", () => {
    const wake = causal("wake", { createdBy: "agent", notification: true, runId: "run-wake" });
    const launch = causal("launch", { ...fromMcp, crew: true, causedBy: "wake" });
    const steer = causal("steer", { ...fromMcp, runId: "run-wake", causedBy: "computer" });
    const unclaimed = causal("unclaimed", { ...fromMcp, runId: "run-other" });
    const scheduled = causal("scheduled", { creationSource: "server", runId: "run-scheduled" });
    const worker = causal("worker", { ...fromMcp, crew: true, causedBy: "scheduled" });
    const quietTask = causal("quiet-task", { creationSource: "server", runId: "run-quiet-task" });
    const quietWorker = causal("quiet-worker", { ...fromMcp, crew: true, causedBy: "quiet-task" });
    const workerWake = causal("worker-wake", {
      createdBy: "agent",
      notification: true,
      runId: "run-worker-wake",
      causedBy: "quiet-worker",
    });
    const subWorker = causal("sub-worker", { ...fromMcp, crew: true, causedBy: "worker-wake" });
    const orphan = causal("orphan", { ...fromMcp, runId: "run-orphan", causedBy: "gone" });
    const byId = messages([
      computer,
      wake,
      launch,
      steer,
      unclaimed,
      scheduled,
      worker,
      quietTask,
      quietWorker,
      workerWake,
      subWorker,
      orphan,
    ]);
    const claims = new Map([
      ["run-wake", { origin: "phone", basis: "claim" } as const],
      ["run-scheduled", { origin: "computer", basis: "claim" } as const],
      ["run-worker-wake", { origin: "phone", basis: "claim" } as const],
      ["run-orphan", { origin: "computer", basis: "claim" } as const],
    ]);
    const claimOfRun = (runId: string) => claims.get(runId);
    assert.deepStrictEqual(resolveMessageOrigin(wake, byId, claimOfRun), {
      origin: "phone",
      basis: "claim",
      via: "agent",
    });
    // Work the claimed turn caused inherits its device.
    assert.deepStrictEqual(resolveMessageOrigin(launch, byId, claimOfRun), {
      origin: "phone",
      basis: "claim",
      via: "crew",
    });
    // A recorded cause wins over the claim; an unclaimed run keeps the prompt's own origin.
    assert.deepStrictEqual(resolveMessageOrigin(steer, byId, claimOfRun), {
      origin: "computer",
      basis: "stamp",
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(unclaimed, byId, claimOfRun), {
      origin: "agent",
      basis: "stamp",
    });
    // An unknown prompt counts to its run's claim, and so does the work it causes.
    assert.deepStrictEqual(resolveMessageOrigin(scheduled, byId, claimOfRun), {
      origin: "computer",
      basis: "claim",
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(worker, byId, claimOfRun), {
      origin: "computer",
      basis: "claim",
      via: "crew",
    });
    // A chain ending at an unclaimed unknown prompt counts to a claim on a run along the way.
    assert.deepStrictEqual(resolveMessageOrigin(workerWake, byId, claimOfRun), {
      origin: "phone",
      basis: "claim",
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(subWorker, byId, claimOfRun), {
      origin: "phone",
      basis: "claim",
      via: "crew",
    });
    // So does a prompt whose recorded cause is missing.
    assert.deepStrictEqual(resolveMessageOrigin(orphan, byId, claimOfRun), {
      origin: "computer",
      basis: "claim",
      via: "agent",
    });
  });
});

describe("settleOrigin", () => {
  it("keeps usage with no recorded parent as Unknown, and labels history that can never trace", () => {
    const recorded = Date.parse(USAGE_ORIGINS_RECORDED_SINCE);
    const phone = { origin: "phone", basis: "stamp" } as const;
    assert.deepStrictEqual(settleOrigin(phone, recorded - 1, false), phone);
    assert.deepStrictEqual(settleOrigin(phone, recorded, true), phone);
    assert.deepStrictEqual(settleOrigin(null, recorded, false), {
      origin: "unknown",
      basis: "default",
    });
    // Agent work keeps who sent it.
    assert.deepStrictEqual(
      settleOrigin({ origin: "crew", basis: "notification" }, recorded, false),
      {
        origin: "unknown",
        basis: "default",
        via: "crew",
      },
    );
    assert.deepStrictEqual(settleOrigin({ origin: "unknown", basis: "server" }, recorded, false), {
      origin: "unknown",
      basis: "default",
    });
    assert.deepStrictEqual(
      settleOrigin({ origin: "agent", basis: "sender" }, recorded - 1, false),
      {
        origin: "unknown",
        basis: "beforeOrigins",
      },
    );
    assert.deepStrictEqual(settleOrigin(null, recorded, true), {
      origin: "unknown",
      basis: "archive",
    });
  });
});

const seedThread = (input: {
  id: string;
  crewOf?: string;
  causedBy?: Record<string, string>;
  worktreePath?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: input.id,
      project_id: "project",
      title: input.id,
      default_provider: "claudeAgent",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: "2026-08-07T00:00:00.000Z",
      updated_at: "2026-08-07T00:00:00.000Z",
      payload_json: encodeJson({
        id: input.id,
        crewOf: input.crewOf ?? null,
        worktreePath: input.worktreePath ?? null,
        ...(input.causedBy === undefined ? {} : { causedBy: input.causedBy }),
      }),
    })}`;
  });

const seedRun = (input: {
  id: string;
  ordinal: number;
  threadId: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  message?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providerThreadId = `provider-thread-${input.sessionId}`;
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_provider_threads ${sql.insert({
      provider_thread_id: providerThreadId,
      thread_id: input.threadId,
      provider: "claudeAgent",
      status: "active",
      updated_at: input.startedAt,
      payload_json: encodeJson({
        nativeThreadRef: { driver: "claudeAgent", nativeId: input.sessionId, strength: "strong" },
      }),
    })}`;
    if (input.message !== undefined) {
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: `message-${input.id}`,
        thread_id: input.threadId,
        run_id: `run-${input.id}`,
        role: "user",
        streaming: 0,
        created_at: input.startedAt,
        updated_at: input.startedAt,
        payload_json: encodeJson(input.message),
      })}`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: `run-${input.id}`,
      thread_id: input.threadId,
      ordinal: input.ordinal,
      provider: "claudeAgent",
      provider_thread_id: providerThreadId,
      status: "completed",
      requested_at: input.startedAt,
      payload_json: encodeJson({ userMessageId: `message-${input.id}` }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: `attempt-${input.id}`,
      thread_id: input.threadId,
      run_id: `run-${input.id}`,
      attempt_ordinal: 1,
      root_node_id: `node-${input.id}`,
      provider: "claudeAgent",
      provider_thread_id: providerThreadId,
      status: "completed",
      payload_json: "{}",
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: `turn-${input.id}`,
      thread_id: input.threadId,
      provider_thread_id: providerThreadId,
      node_id: `node-${input.id}`,
      run_attempt_id: `attempt-${input.id}`,
      ordinal: input.ordinal,
      status: "completed",
      started_at: input.startedAt,
      completed_at: input.completedAt ?? null,
      payload_json: "{}",
    })}`;
  });

describe("UsageOrigins.read", () => {
  it.effect("joins each provider turn to its run's starting message and counts prompts", () =>
    Effect.gen(function* () {
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "worker", crewOf: "lead", worktreePath: "/wt/worker" });
      yield* seedRun({
        id: "phone",
        ordinal: 1,
        threadId: "lead",
        sessionId: "lead-session",
        startedAt: "2026-08-07T01:00:00.000Z",
        completedAt: "2026-08-07T01:10:00.000Z",
        message: {
          createdBy: "user",
          creationSource: "web",
          origin: { surface: "web", deviceType: "mobile" },
        },
      });
      yield* seedRun({
        id: "brief",
        ordinal: 1,
        threadId: "worker",
        sessionId: "worker-session",
        startedAt: "2026-08-07T01:05:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
        },
      });
      // A worker launched for the phone prompt: its uncaused prompts follow the thread's cause.
      yield* seedThread({
        id: "caused-worker",
        crewOf: "lead",
        causedBy: { threadId: "lead", messageId: "message-phone" },
      });
      yield* seedRun({
        id: "wake",
        ordinal: 1,
        threadId: "caused-worker",
        sessionId: "caused-session",
        startedAt: "2026-08-07T01:07:00.000Z",
        message: { createdBy: "agent", creationSource: "provider" },
      });
      // Two hops: relay -> wake -> (its thread's cause) phone.
      yield* seedRun({
        id: "relay",
        ordinal: 2,
        threadId: "worker",
        sessionId: "worker-session",
        startedAt: "2026-08-07T01:20:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
          causedBy: { threadId: "caused-worker", messageId: "message-wake" },
        },
      });
      yield* seedRun({
        id: "task-update",
        ordinal: 3,
        threadId: "worker",
        sessionId: "worker-session",
        startedAt: "2026-08-07T01:40:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "provider",
          notification: { source: { kind: "background_task" }, outcome: "updated" },
        },
      });
      yield* seedRun({
        id: "gone",
        ordinal: 2,
        threadId: "lead",
        sessionId: "lead-session",
        startedAt: "2026-08-07T02:00:00.000Z",
      });
      yield* seedRun({
        id: "before-window",
        ordinal: 3,
        threadId: "lead",
        sessionId: "old-session",
        startedAt: "2026-07-01T00:00:00.000Z",
        message: { createdBy: "user", creationSource: "web" },
      });

      // A pipeline the worker ran, claimed for the phone prompt; a claim made again replaces it.
      const claims = yield* UsageClaims.UsageClaims;
      const cause = { threadId: ThreadId.make("lead"), messageId: MessageId.make("message-phone") };
      yield* claims.claim({
        target: { kind: "session", sessionId: "pipeline-session" },
        value: {
          causedBy: {
            threadId: ThreadId.make("worker"),
            messageId: MessageId.make("message-brief"),
          },
        },
      });
      yield* claims.claim({
        target: { kind: "session", sessionId: "pipeline-session" },
        value: { causedBy: cause },
      });
      yield* claims.claim({
        target: { kind: "session", sessionId: "removed" },
        value: { causedBy: cause },
      });
      yield* claims.claim({ target: { kind: "session", sessionId: "removed" }, value: null });
      // Turns whose prompt has no cause, claimed for a device: a voice journal's wake and upkeep.
      yield* claims.claim({
        target: { kind: "run", runId: "run-task-update" },
        value: { device: "phone" },
      });
      yield* claims.claim({
        target: { kind: "run", runId: "run-gone" },
        value: { device: "computer" },
      });
      // A worker launched from the claimed wake inherits its device.
      yield* seedThread({
        id: "journal-worker",
        crewOf: "worker",
        causedBy: { threadId: "worker", messageId: "message-task-update" },
      });
      yield* seedRun({
        id: "journal-ask",
        ordinal: 1,
        threadId: "journal-worker",
        sessionId: "journal-session",
        startedAt: "2026-08-07T01:50:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
        },
      });

      // A wake claimed for a later prompt, whose run is claimed after it for the phone prompt.
      yield* seedThread({ id: "firstmate" });
      for (const [ordinal, id, startedAt] of [
        [1, "fm-early", "2026-08-07T04:00:00.000Z"],
        [2, "fm-later", "2026-08-07T04:10:00.000Z"],
      ] as const) {
        yield* seedRun({
          id,
          ordinal,
          threadId: "firstmate",
          sessionId: "fm-session",
          startedAt,
          message: { createdBy: "agent", creationSource: "provider" },
        });
      }
      yield* claims.claim({
        target: { kind: "run", runId: "run-fm-early" },
        value: {
          causedBy: {
            threadId: ThreadId.make("firstmate"),
            messageId: MessageId.make("message-fm-later"),
          },
        },
      });
      yield* claims.claim({
        target: { kind: "run", runId: "run-fm-later" },
        value: { causedBy: cause },
      });
      // An unstamped scheduled prompt claimed for the computer, and the worker it launched.
      yield* seedThread({ id: "scheduled" });
      yield* seedRun({
        id: "scheduled",
        ordinal: 1,
        threadId: "scheduled",
        sessionId: "scheduled-session",
        startedAt: "2026-08-07T05:00:00.000Z",
        message: { createdBy: "user", creationSource: "server" },
      });
      yield* claims.claim({
        target: { kind: "run", runId: "run-scheduled" },
        value: { device: "computer" },
      });
      yield* seedThread({
        id: "scheduled-worker",
        crewOf: "scheduled",
        causedBy: { threadId: "scheduled", messageId: "message-scheduled" },
      });
      yield* seedRun({
        id: "scheduled-ask",
        ordinal: 1,
        threadId: "scheduled-worker",
        sessionId: "scheduled-worker-session",
        startedAt: "2026-08-07T05:05:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
        },
      });

      const origins = yield* UsageOrigins;
      const snapshot = yield* origins.read(
        Date.parse("2026-08-07T00:00:00.000Z"),
        Date.parse("2026-08-08T00:00:00.000Z"),
      );
      const index = new UsageOriginIndex(snapshot);
      const at = (sessionId: string, iso: string, cwd?: string) =>
        index.lookup({ sessionId, timestampMs: Date.parse(iso), cwd });
      assert.deepStrictEqual(at("lead-session", "2026-08-07T01:01:00Z"), {
        origin: "phone",
        basis: "stamp",
      });
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:06:00Z"), {
        origin: "crew",
        basis: "stamp",
      });
      const viaCrew = { origin: "phone", basis: "stamp", via: "crew" } as const;
      assert.deepStrictEqual(at("caused-session", "2026-08-07T01:08:00Z"), viaCrew);
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:21:00Z"), viaCrew);
      const journal = { origin: "phone", basis: "claim", via: "crew" } as const;
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:41:00Z"), journal);
      assert.deepStrictEqual(at("journal-session", "2026-08-07T01:51:00Z"), journal);
      assert.deepStrictEqual(at("lead-session", "2026-08-07T02:01:00Z"), {
        origin: "computer",
        basis: "claim",
        via: "agent",
      });
      assert.strictEqual(at("old-session", "2026-07-01T00:01:00Z"), null);
      assert.deepStrictEqual(at("pipeline-session", "2026-08-07T03:00:00Z"), {
        origin: "phone",
        basis: "stamp",
        via: "agent",
      });
      assert.strictEqual(at("removed", "2026-08-07T03:00:00Z"), null);
      const fromPhone = { origin: "phone", basis: "stamp", via: "agent" } as const;
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:01:00Z"), fromPhone);
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:11:00Z"), fromPhone);
      assert.deepStrictEqual(at("scheduled-session", "2026-08-07T05:01:00Z"), {
        origin: "computer",
        basis: "claim",
        via: "agent",
      });
      assert.deepStrictEqual(at("scheduled-worker-session", "2026-08-07T05:06:00Z"), {
        origin: "computer",
        basis: "claim",
        via: "crew",
      });
      // A CLI run inside the worker's worktree counts to the worker's turn then.
      assert.deepStrictEqual(at("cli-session", "2026-08-07T01:25:00Z", "/wt/worker/runs"), viaCrew);
      assert.deepStrictEqual(
        snapshot.prompts
          .map(({ key }) => `${key.origin}/${key.basis}/${key.via ?? "-"}`)
          .toSorted(),
        [
          "computer/claim/agent",
          "computer/claim/crew",
          "crew/stamp/-",
          "phone/claim/crew",
          "phone/claim/crew",
          "phone/stamp/-",
          "phone/stamp/agent",
          "phone/stamp/agent",
          "phone/stamp/crew",
          "phone/stamp/crew",
        ],
      );
    }).pipe(
      Effect.provide(
        usageOriginsLayer.pipe(
          Layer.provideMerge(UsageClaims.layer),
          Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
        ),
      ),
    ),
  );
});
