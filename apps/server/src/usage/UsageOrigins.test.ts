import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { MessageId, ThreadId, USAGE_ORIGINS_RECORDED_SINCE } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClaims from "./UsageClaims.ts";
import * as UsageSessionRegister from "./UsageSessionRegister.ts";
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
  type UsageOriginKey,
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
      [{ surface: "web", deviceType: "mobile" }, "phone/stamp/typed"],
      [{ surface: "web", deviceType: "tablet" }, "phone/stamp/typed"],
      [{ creationSource: "mobile", surface: "mobile", deviceType: "mobile" }, "phone/stamp/typed"],
      [{ surface: "desktop", deviceType: "desktop" }, "computer/stamp/typed"],
      [{ surface: "web", deviceType: "desktop" }, "computer/stamp/typed"],
      [{ surface: "web", deviceType: "unknown" }, "unknown/stamp/unknownDevice"],
      [
        { createdBy: "agent", creationSource: "mcp", surface: "mcp", deviceType: "bot" },
        "agent/stamp/noCause",
      ],
      [{ creationSource: "mobile" }, "phone/nativeApp/typed"],
      [{ createdBy: "agent", creationSource: "mcp" }, "agent/sender/noCause"],
      [{ createdBy: "agent", creationSource: "provider" }, "agent/sender/noCause"],
      [{ createdBy: "agent", creationSource: "server" }, "agent/sender/noCause"],
      // Background-task updates the provider posts never carry a stamp.
      [
        { createdBy: "agent", creationSource: "provider", notification: true },
        "agent/notification/unnamedTurn",
      ],
      [
        { createdBy: "agent", creationSource: "server", notification: true },
        "agent/notification/unnamedTurn",
      ],
      [{ crew: true, createdBy: "agent", notification: true }, "crew/notification/unnamedTurn"],
      [{ creationSource: "web" }, "unknown/unstamped/unstamped"],
      [{ creationSource: "server" }, "unknown/server/serverPrompt"],
      [{ createdBy: null, creationSource: null }, "unknown/unstamped/unstamped"],
      [{ crew: true, createdBy: "agent", creationSource: "mcp" }, "crew/sender/noCause"],
      [{ crew: true, surface: "mcp", deviceType: "bot" }, "crew/stamp/noCause"],
      // A prompt the captain types into a crew thread is still his device's.
      [{ crew: true, surface: "web", deviceType: "mobile" }, "phone/stamp/typed"],
      [{ crew: true, creationSource: "web" }, "unknown/unstamped/unstamped"],
    ];
    for (const [input, expected] of cases) {
      const { origin, basis, reason } = classifyMessageOrigin(message(input));
      assert.strictEqual(`${origin}/${basis}/${reason}`, expected, JSON.stringify(input));
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
      reason: "inherited",
    });
    assert.deepStrictEqual(resolveMessageOrigin(direct, byId), {
      origin: "computer",
      basis: "stamp",
      via: "agent",
      reason: "inherited",
    });
    // A human prompt is a root even if something named a cause for it.
    const typed = causal("typed", { surface: "web", deviceType: "desktop", causedBy: "phone" });
    assert.deepStrictEqual(resolveMessageOrigin(typed, byId), {
      origin: "computer",
      basis: "stamp",
      reason: "typed",
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
    // A recorded cause that reaches no device is told apart from no cause at all.
    const untraced = { origin: "crew", basis: "stamp", reason: "untracedCause" } as const;
    assert.deepStrictEqual(resolveMessageOrigin(missing, byId), untraced);
    assert.deepStrictEqual(resolveMessageOrigin(left, byId), {
      origin: "agent",
      basis: "stamp",
      reason: "untracedCause",
    });
    assert.deepStrictEqual(resolveMessageOrigin(fromServer, byId), untraced);
    assert.deepStrictEqual(resolveMessageOrigin(uncaused, byId), {
      origin: "crew",
      basis: "stamp",
      reason: "noCause",
    });
    // MAX_CAUSE_DEPTH hops reach the phone; one more does not.
    assert.deepStrictEqual(resolveMessageOrigin(hops[MAX_CAUSE_DEPTH - 1]!, byId), {
      origin: "phone",
      basis: "stamp",
      via: "agent",
      reason: "inherited",
    });
    assert.deepStrictEqual(resolveMessageOrigin(hops[MAX_CAUSE_DEPTH]!, byId), {
      origin: "agent",
      basis: "stamp",
      reason: "untracedCause",
    });
  });

  describe("UsageOriginIndex", () => {
    const late = { origin: "unknown", basis: "default", reason: "lateRecord" } as const;
    const unregistered = {
      origin: "unknown",
      basis: "default",
      reason: "unregisteredSession",
    } as const;

    it("credits a record to its session's turn running at the time", () => {
      const phone = { origin: "phone", basis: "stamp", reason: "typed" } as const;
      const agent = { origin: "agent", basis: "stamp", reason: "noCause" } as const;
      const index = new UsageOriginIndex({
        turns: [
          { sessionId: "s", threadId: "t", startedAtMs: 2_000, completedAtMs: null, key: agent },
          { sessionId: "s", threadId: "t", startedAtMs: 1_000, completedAtMs: 1_500, key: phone },
        ],
        worktrees: [],
        claims: [],
        registrations: [],
      });
      const at = (sessionId: string, timestampMs: number) =>
        index.lookup({ sessionId, timestampMs });
      // A T3 session's record outside its turns, and a session T3 never ran, say why they miss.
      assert.deepStrictEqual(at("s", 999), late);
      assert.deepStrictEqual(at("s", 1_000), phone);
      // Late records within the grace still belong to the finished turn.
      assert.deepStrictEqual(at("s", 1_900), phone);
      assert.deepStrictEqual(at("s", 2_000), agent);
      assert.deepStrictEqual(at("s", 10 * 60 * 1000), agent);
      assert.deepStrictEqual(at("other", 1_200), unregistered);
    });

    it("credits sessions outside T3 by claim, then by registration, then by their folder", () => {
      const phone = { origin: "phone", basis: "stamp", reason: "typed" } as const;
      const computer = { origin: "computer", basis: "stamp", reason: "typed" } as const;
      const claimed = {
        origin: "phone",
        basis: "stamp",
        via: "agent",
        reason: "inherited",
      } as const;
      const byFolder = (key: UsageOriginKey): UsageOriginKey => ({ ...key, folder: true });
      const bySession = (key: UsageOriginKey): UsageOriginKey => ({ ...key, claim: "session" });
      const byDirectory: UsageOriginKey = { ...claimed, claim: "directory" };
      const afterGrace = 1_000 + 6 * 60 * 1000;
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
          // A session resumed for different work, claimed from each start; listed out of order.
          { kind: "session", target: "engine", fromMs: 20_000, key: computer },
          { kind: "session", target: "engine", fromMs: 10_000, key: phone },
          { kind: "session", target: "resumed", key: claimed },
          { kind: "session", target: "resumed", fromMs: 10_000, key: computer },
        ],
        registrations: [
          { sessionId: "pipeline-session", startedAtMs: 0, threadId: "worker" },
          // A review the worker started, resumed later from a terminal.
          { sessionId: "review", startedAtMs: 30_000 },
          { sessionId: "review", startedAtMs: 5_000, threadId: "worker" },
          { sessionId: "terminal", startedAtMs: 100 },
          // Stamped in whole seconds: started in the same second as the thread's turn.
          { sessionId: "child", startedAtMs: 19_500, threadId: "next-worker" },
          { sessionId: "lost", startedAtMs: 100, threadId: "unknown-thread" },
          // FirstMate work whose task names no thread T3 knows.
          { sessionId: "fm-lost", startedAtMs: 100, unmatched: true },
          // T3 runs this session itself, so its registration says nothing more.
          { sessionId: "w2", startedAtMs: 0 },
        ],
      });
      const at = (sessionId: string, timestampMs: number, cwd?: string) =>
        index.lookup({ sessionId, timestampMs, cwd });
      assert.deepStrictEqual(at("pipeline-session", 9_000), bySession(claimed));
      assert.deepStrictEqual(at("pipeline-session", -1), bySession(claimed));
      // Each record counts to the latest claim started by then; before the first, as unclaimed.
      assert.deepStrictEqual(at("engine", 10_000), bySession(phone));
      assert.deepStrictEqual(at("engine", 19_999), bySession(phone));
      assert.deepStrictEqual(at("engine", 25_000), bySession(computer));
      assert.deepStrictEqual(at("engine", 9_999, "/runs/pipeline"), byDirectory);
      assert.deepStrictEqual(at("engine", 9_999), unregistered);
      // A claim with no start covers the session until a later one starts.
      assert.deepStrictEqual(at("resumed", 9_999), bySession(claimed));
      assert.deepStrictEqual(at("resumed", 10_000), bySession(computer));
      // A registration counts to the turn its thread was running when the session started.
      const byRegistration = (key: UsageOriginKey): UsageOriginKey => ({
        ...key,
        registered: true,
      });
      const terminal = {
        origin: "computer",
        basis: "terminal",
        reason: "terminal",
        registered: true,
      } as const;
      assert.deepStrictEqual(at("review", 9_000, "/wt/worker/nested"), byRegistration(computer));
      assert.deepStrictEqual(at("review", 31_000), terminal);
      assert.deepStrictEqual(at("terminal", 9_000, "/wt/worker"), terminal);
      assert.deepStrictEqual(at("child", 21_000), byRegistration(claimed));
      assert.deepStrictEqual(at("lost", 2_000, "/wt/worker"), byFolder(phone));
      // A registration naming no turn and nothing else to go by is reported apart from no registration.
      assert.deepStrictEqual(at("lost", 2_000), {
        origin: "unknown",
        basis: "default",
        reason: "unmatchedRegistration",
      });
      assert.deepStrictEqual(at("fm-lost", 2_000), {
        origin: "unknown",
        basis: "default",
        reason: "unmatchedRegistration",
      });
      assert.deepStrictEqual(at("cli", 9_000, "/runs/pipeline/review"), byDirectory);
      assert.deepStrictEqual(at("cli", 9_000, "/runs/pipeline-other"), unregistered);
      // A child run in a thread's worktree counts to that thread's latest turn by then.
      assert.deepStrictEqual(at("cli", 2_000, "/wt/worker/backtest"), byFolder(phone));
      assert.deepStrictEqual(at("cli", 7_000, "/wt/worker"), byFolder(computer));
      assert.deepStrictEqual(at("cli", 21_000, "/wt/worker"), byFolder(claimed));
      assert.deepStrictEqual(at("cli", -1, "/wt/worker"), unregistered);
      // The deepest folder wins.
      assert.deepStrictEqual(at("cli", 7_000, "/wt/worker/nested/x"), byDirectory);
      // Claude names a session's scratchpad folder for the session.
      assert.deepStrictEqual(
        at("grok", afterGrace, "/tmp/claude-501/-proj/lead/scratchpad"),
        byFolder(phone),
      );
      // A terminal resume of a T3 session long after its turn ended is not T3's, even in its worktree.
      assert.deepStrictEqual(at("w2", 6_000 + 6 * 60 * 1000, "/wt/worker"), late);
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
      ["run-wake", { origin: "phone", basis: "claim", reason: "journal" } as const],
      ["run-scheduled", { origin: "computer", basis: "claim", reason: "upkeep" } as const],
      ["run-worker-wake", { origin: "phone", basis: "claim", reason: "journal" } as const],
      ["run-orphan", { origin: "computer", basis: "claim", reason: "upkeep" } as const],
    ]);
    const claimOfRun = (runId: string) => claims.get(runId);
    const journal = { origin: "phone", basis: "claim", reason: "journal", claim: "run" } as const;
    const upkeep = { origin: "computer", basis: "claim", reason: "upkeep", claim: "run" } as const;
    assert.deepStrictEqual(resolveMessageOrigin(wake, byId, claimOfRun), {
      ...journal,
      via: "agent",
    });
    // Work the claimed turn caused inherits its device.
    assert.deepStrictEqual(resolveMessageOrigin(launch, byId, claimOfRun), {
      ...journal,
      via: "crew",
    });
    // A recorded cause wins over the claim; an unclaimed run keeps the prompt's own origin.
    assert.deepStrictEqual(resolveMessageOrigin(steer, byId, claimOfRun), {
      origin: "computer",
      basis: "stamp",
      via: "agent",
      reason: "inherited",
    });
    assert.deepStrictEqual(resolveMessageOrigin(unclaimed, byId, claimOfRun), {
      origin: "agent",
      basis: "stamp",
      reason: "noCause",
    });
    // An unknown prompt counts to its run's claim, and so does the work it causes.
    assert.deepStrictEqual(resolveMessageOrigin(scheduled, byId, claimOfRun), {
      ...upkeep,
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(worker, byId, claimOfRun), {
      ...upkeep,
      via: "crew",
    });
    // A chain ending at an unclaimed unknown prompt counts to a claim on a run along the way.
    assert.deepStrictEqual(resolveMessageOrigin(workerWake, byId, claimOfRun), {
      ...journal,
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(subWorker, byId, claimOfRun), {
      ...journal,
      via: "crew",
    });
    // So does a prompt whose recorded cause is missing.
    assert.deepStrictEqual(resolveMessageOrigin(orphan, byId, claimOfRun), {
      ...upkeep,
      via: "agent",
    });
  });
});

describe("settleOrigin", () => {
  it("counts usage with no device evidence to the computer, keeping why, and labels history that can never trace", () => {
    const recorded = Date.parse(USAGE_ORIGINS_RECORDED_SINCE);
    const phone = { origin: "phone", basis: "stamp", reason: "typed" } as const;
    assert.deepStrictEqual(settleOrigin(phone, recorded - 1, "live"), phone);
    assert.deepStrictEqual(settleOrigin(phone, recorded, "archive"), phone);
    assert.deepStrictEqual(
      settleOrigin(
        { origin: "unknown", basis: "default", reason: "unregisteredSession" },
        recorded,
        "live",
      ),
      { origin: "computer", basis: "default", reason: "unregisteredSession" },
    );
    // Agent work keeps who sent it, and how it was matched.
    assert.deepStrictEqual(
      settleOrigin(
        { origin: "crew", basis: "notification", reason: "unnamedTurn", folder: true },
        recorded,
        "live",
      ),
      { origin: "computer", basis: "default", via: "crew", reason: "unnamedTurn", folder: true },
    );
    assert.deepStrictEqual(
      settleOrigin(
        { origin: "unknown", basis: "server", reason: "serverPrompt" },
        recorded,
        "live",
      ),
      { origin: "computer", basis: "default", reason: "serverPrompt" },
    );
    assert.deepStrictEqual(
      settleOrigin({ origin: "agent", basis: "sender", reason: "noCause" }, recorded - 1, "live"),
      { origin: "computer", basis: "beforeOrigins", reason: "beforeStamps" },
    );
    const missed = { origin: "unknown", basis: "default", reason: "unregisteredSession" } as const;
    assert.deepStrictEqual(settleOrigin(missed, recorded, "archive"), {
      origin: "computer",
      basis: "archive",
      reason: "archive",
    });
    assert.deepStrictEqual(settleOrigin(missed, recorded - 1, "account"), {
      origin: "computer",
      basis: "archive",
      reason: "accountOnly",
    });
  });
});

const seedThread = (input: {
  id: string;
  crewOf?: string;
  causedBy?: Record<string, string>;
  worktreePath?: string;
  rootThreadId?: string;
  environment?: Record<string, string>;
  createdAt?: string;
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
      created_at: input.createdAt ?? "2026-08-07T00:00:00.000Z",
      updated_at: input.createdAt ?? "2026-08-07T00:00:00.000Z",
      payload_json: encodeJson({
        id: input.id,
        crewOf: input.crewOf ?? null,
        worktreePath: input.worktreePath ?? null,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        ...(input.causedBy === undefined ? {} : { causedBy: input.causedBy }),
        ...(input.rootThreadId === undefined
          ? {}
          : { lineage: { rootThreadId: input.rootThreadId } }),
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

      // A crew worker's subagent has no crew link of its own; its lineage leads to the worker.
      yield* seedThread({ id: "worker-subagent", rootThreadId: "worker" });
      yield* seedRun({
        id: "sub-brief",
        ordinal: 1,
        threadId: "worker-subagent",
        sessionId: "worker-subagent-session",
        startedAt: "2026-08-07T01:30:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
        },
      });

      // Two runs claimed for each other's prompts. The second's prompt traces to a run claimed
      // for the phone, so both count there whichever is resolved first.
      yield* seedThread({ id: "cycle" });
      for (const [ordinal, id, startedAt, causedBy] of [
        [1, "cycle-b", "2026-08-07T06:00:00.000Z", undefined],
        [2, "cycle-a", "2026-08-07T06:10:00.000Z", "message-cycle-c"],
        [3, "cycle-c", "2026-08-07T06:20:00.000Z", undefined],
      ] as const) {
        yield* seedRun({
          id,
          ordinal,
          threadId: "cycle",
          sessionId: "cycle-session",
          startedAt,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            ...(causedBy === undefined
              ? {}
              : { causedBy: { threadId: "cycle", messageId: causedBy } }),
          },
        });
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: "message-cycle-a-follow-up",
        thread_id: "cycle",
        run_id: "run-cycle-a",
        role: "user",
        streaming: 0,
        created_at: "2026-08-07T06:15:00.000Z",
        updated_at: "2026-08-07T06:15:00.000Z",
        payload_json: encodeJson({ createdBy: "agent", creationSource: "provider" }),
      })}`;
      for (const [run, message] of [
        ["run-cycle-a", "message-cycle-b"],
        ["run-cycle-b", "message-cycle-a"],
      ] as const) {
        yield* claims.claim({
          target: { kind: "run", runId: run },
          value: {
            causedBy: { threadId: ThreadId.make("cycle"), messageId: MessageId.make(message) },
          },
        });
      }
      yield* claims.claim({
        target: { kind: "run", runId: "run-cycle-c" },
        value: { device: "phone" },
      });

      // A FirstMate task relaunched in a new thread, and a task of the same name in another home.
      const fmTask = { FM_TASK_ID: "task-a", FM_HOME: "/fm" };
      yield* seedThread({ id: "task-first", environment: fmTask });
      yield* seedThread({
        id: "task-again",
        environment: fmTask,
        createdAt: "2026-08-07T06:30:00.000Z",
      });
      yield* seedThread({
        id: "task-elsewhere",
        environment: { FM_TASK_ID: "task-a", FM_HOME: "/other" },
        createdAt: "2026-08-07T06:45:00.000Z",
      });
      for (const threadId of ["task-first", "task-again", "task-elsewhere"]) {
        yield* seedRun({
          id: threadId,
          ordinal: 1,
          threadId,
          sessionId: `${threadId}-session`,
          startedAt: "2026-08-07T06:50:00.000Z",
          message: {
            createdBy: "user",
            creationSource: "web",
            origin: {
              surface: "web",
              deviceType: threadId === "task-again" ? "mobile" : "desktop",
            },
          },
        });
      }

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
        reason: "typed",
      });
      const uncausedCrew = { origin: "crew", basis: "stamp", reason: "noCause" } as const;
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:06:00Z"), uncausedCrew);
      const viaCrew = {
        origin: "phone",
        basis: "stamp",
        via: "crew",
        reason: "inherited",
      } as const;
      assert.deepStrictEqual(at("caused-session", "2026-08-07T01:08:00Z"), viaCrew);
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:21:00Z"), viaCrew);
      const journal = {
        origin: "phone",
        basis: "claim",
        via: "crew",
        reason: "journal",
        claim: "run",
      } as const;
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:41:00Z"), journal);
      assert.deepStrictEqual(at("journal-session", "2026-08-07T01:51:00Z"), journal);
      const upkeep = {
        origin: "computer",
        basis: "claim",
        reason: "upkeep",
        claim: "run",
      } as const;
      assert.deepStrictEqual(at("lead-session", "2026-08-07T02:01:00Z"), {
        ...upkeep,
        via: "agent",
      });
      const unregistered = {
        origin: "unknown",
        basis: "default",
        reason: "unregisteredSession",
      } as const;
      assert.deepStrictEqual(at("old-session", "2026-07-01T00:01:00Z"), unregistered);
      assert.deepStrictEqual(at("pipeline-session", "2026-08-07T03:00:00Z"), {
        origin: "phone",
        basis: "stamp",
        via: "agent",
        reason: "inherited",
        claim: "session",
      });
      assert.deepStrictEqual(at("removed", "2026-08-07T03:00:00Z"), unregistered);
      const fromPhone = {
        origin: "phone",
        basis: "stamp",
        via: "agent",
        reason: "inherited",
        claim: "run",
      } as const;
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:01:00Z"), fromPhone);
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:11:00Z"), fromPhone);
      assert.deepStrictEqual(at("scheduled-session", "2026-08-07T05:01:00Z"), {
        ...upkeep,
        via: "agent",
      });
      assert.deepStrictEqual(at("scheduled-worker-session", "2026-08-07T05:06:00Z"), {
        ...upkeep,
        via: "crew",
      });
      assert.deepStrictEqual(at("worker-subagent-session", "2026-08-07T01:31:00Z"), uncausedCrew);
      const cyclePhone = { ...journal, via: "agent" } as const;
      assert.deepStrictEqual(at("cycle-session", "2026-08-07T06:01:00Z"), cyclePhone);
      assert.deepStrictEqual(at("cycle-session", "2026-08-07T06:11:00Z"), cyclePhone);
      // A CLI run inside the worker's worktree counts to the worker's turn then.
      assert.deepStrictEqual(at("cli-session", "2026-08-07T01:25:00Z", "/wt/worker/runs"), {
        ...viaCrew,
        folder: true,
      });
      // Registered sessions: by their task's latest thread in that home, then by their thread.
      assert.deepStrictEqual(at("task-review", "2026-08-07T07:06:00Z"), {
        origin: "phone",
        basis: "stamp",
        reason: "typed",
        registered: true,
      });
      assert.deepStrictEqual(at("probe", "2026-08-07T01:26:00Z"), { ...viaCrew, registered: true });
      assert.deepStrictEqual(at("my-terminal", "2026-08-07T03:01:00Z"), {
        origin: "computer",
        basis: "terminal",
        reason: "terminal",
        registered: true,
      });
      // T3's own session, though older than any turn read, and FirstMate work with no thread.
      assert.deepStrictEqual(at("old-session", "2026-08-07T01:00:00Z"), unregistered);
      assert.deepStrictEqual(at("fm-only", "2026-08-07T01:01:00Z"), {
        ...unregistered,
        reason: "unmatchedRegistration",
      });
      assert.deepStrictEqual(
        snapshot.prompts
          .map(({ key }) => `${key.origin}/${key.basis}/${key.via ?? "-"}`)
          .toSorted(),
        [
          "computer/claim/agent",
          "computer/claim/crew",
          "computer/stamp/-",
          "computer/stamp/-",
          "crew/stamp/-",
          "crew/stamp/-",
          "phone/claim/agent",
          "phone/claim/agent",
          "phone/claim/agent",
          "phone/claim/agent",
          "phone/claim/crew",
          "phone/claim/crew",
          "phone/stamp/-",
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
          Layer.provide(
            Layer.succeed(
              UsageSessionRegister.UsageSessionRegister,
              UsageSessionRegister.UsageSessionRegister.of({
                read: () =>
                  Effect.succeed(
                    [
                      {
                        sessionId: "task-review",
                        startedAt: "2026-08-07T07:05:00Z",
                        fmTaskId: "task-a",
                        fmHome: "/fm",
                        threadId: "lead",
                      },
                      { sessionId: "probe", startedAt: "2026-08-07T01:25:00Z", threadId: "worker" },
                      { sessionId: "my-terminal", startedAt: "2026-08-07T03:00:00Z" },
                      { sessionId: "old-session", startedAt: "2026-08-07T00:30:00Z" },
                      { sessionId: "fm-only", startedAt: "2026-08-07T01:00:00Z", fmHome: "/fm" },
                    ].map(({ startedAt, ...entry }) => ({
                      ...entry,
                      provider: "claude",
                      startedAtMs: Date.parse(startedAt),
                    })),
                  ),
              }),
            ),
          ),
          Layer.provideMerge(UsageClaims.layer),
          Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
        ),
      ),
    ),
  );
});
