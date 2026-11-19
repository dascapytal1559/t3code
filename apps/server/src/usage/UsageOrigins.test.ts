import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  MessageId,
  ThreadId,
  USAGE_ORIGINS_RECORDED_SINCE,
  usageOriginCountsByDefault,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClaims from "./UsageClaims.ts";
import * as UsageSessionRegister from "./UsageSessionRegister.ts";
import { encodeJson, seedMessage, seedRun, seedThread } from "./usageOriginsTestSeed.ts";
import {
  classifyMessageOrigin,
  layer as usageOriginsLayer,
  LAUNCHED_UPKEEP,
  MAX_CAUSE_DEPTH,
  resolveMessageOrigin,
  settleOrigin,
  storedOrigin,
  UsageOriginIndex,
  UsageOrigins,
  type BoundOrigin,
  type CausalMessage,
  type OriginMessage,
  type UsageOriginKey,
} from "./UsageOrigins.ts";

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
  coordinator: overrides.coordinator ?? false,
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
    // Decided by following recorded causes, which the watchdog names.
    assert.deepStrictEqual(resolveMessageOrigin(brief, byId), {
      origin: "phone",
      basis: "stamp",
      via: "crew",
      reason: "inherited",
      cause: true,
    });
    assert.deepStrictEqual(resolveMessageOrigin(direct, byId), {
      origin: "computer",
      basis: "stamp",
      via: "agent",
      reason: "inherited",
      cause: true,
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
    const untraced = {
      origin: "crew",
      basis: "stamp",
      reason: "untracedCause",
      cause: true,
    } as const;
    assert.deepStrictEqual(resolveMessageOrigin(missing, byId), untraced);
    assert.deepStrictEqual(resolveMessageOrigin(left, byId), {
      origin: "agent",
      basis: "stamp",
      reason: "untracedCause",
      cause: true,
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
      cause: true,
    });
    assert.deepStrictEqual(resolveMessageOrigin(hops[MAX_CAUSE_DEPTH]!, byId), {
      origin: "agent",
      basis: "stamp",
      reason: "untracedCause",
      cause: true,
    });
  });

  describe("UsageOriginIndex", () => {
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
      // A T3 session's record outside its turns counts with its nearest turn; one T3 never ran
      // says why it misses.
      assert.deepStrictEqual(at("s", 999), phone);
      assert.deepStrictEqual(at("s", 1_000), phone);
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
      // A T3 session's record long after its turn ended still counts with that turn.
      assert.deepStrictEqual(at("w2", 6_000 + 60 * 60 * 1000, "/wt/worker"), computer);
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
      cause: true,
    });
    // A recorded cause wins over the claim; an unclaimed run keeps the prompt's own origin.
    assert.deepStrictEqual(resolveMessageOrigin(steer, byId, claimOfRun), {
      origin: "computer",
      basis: "stamp",
      via: "agent",
      reason: "inherited",
      cause: true,
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
      cause: true,
    });
    // A chain ending at an unclaimed unknown prompt counts to a claim on a run along the way.
    assert.deepStrictEqual(resolveMessageOrigin(workerWake, byId, claimOfRun), {
      ...journal,
      via: "agent",
    });
    assert.deepStrictEqual(resolveMessageOrigin(subWorker, byId, claimOfRun), {
      ...journal,
      via: "crew",
      cause: true,
    });
    // So does a prompt whose recorded cause is missing.
    assert.deepStrictEqual(resolveMessageOrigin(orphan, byId, claimOfRun), {
      ...upkeep,
      via: "agent",
    });
  });

  it("files a coordinator's turn that no claim named and no person typed as upkeep", () => {
    const fm = { coordinator: true } as const;
    const wake = causal("wake", { ...fm, createdBy: "agent", notification: true, runId: "run-w" });
    const restartNote = causal("note", { ...fm, creationSource: "server", runId: "run-n" });
    const relay = causal("relay", { ...fm, ...fromMcp, runId: "run-r" });
    const typed = causal("typed", { ...fm, surface: "web", deviceType: "mobile", runId: "run-t" });
    const oddDevice = causal("odd", { ...fm, surface: "web", deviceType: "tv", runId: "run-o" });
    const named = causal("named", {
      ...fm,
      createdBy: "agent",
      notification: true,
      runId: "run-j",
    });
    const lostCause = causal("lost", {
      ...fm,
      createdBy: "agent",
      notification: true,
      runId: "run-l",
    });
    const worker = causal("worker", { ...fromMcp, crew: true, causedBy: "wake" });
    // A coordinator prompt caused by a named turn counts to that claim, not to upkeep.
    const followUp = causal("follow-up", { ...fm, ...fromMcp, runId: "run-f", causedBy: "named" });
    // Not a coordinator's: a worker's wake is left to its task's cause.
    const workerWake = causal("worker-wake", {
      createdBy: "agent",
      notification: true,
      runId: "run-c",
    });
    const byId = messages([wake, named, followUp]);
    const claims = new Map([
      ["run-j", { origin: "phone", basis: "claim", reason: "journal" } as const],
    ]);
    const claimOfRun = (runId: string) => claims.get(runId);
    // run-l's claim names a cause that reaches no device: still a named turn.
    const runClaimed = (runId: string) => runId === "run-l" || claims.has(runId);
    const resolve = (prompt: CausalMessage) =>
      resolveMessageOrigin(prompt, byId, claimOfRun, runClaimed);
    const upkeep = { origin: "computer", reason: "upkeep" } as const;

    assert.deepStrictEqual(resolve(wake), { ...upkeep, basis: "notification", via: "agent" });
    assert.deepStrictEqual(resolve(restartNote), { ...upkeep, basis: "server" });
    assert.deepStrictEqual(resolve(relay), { ...upkeep, basis: "stamp", via: "agent" });
    assert.deepStrictEqual(resolve(worker), {
      ...upkeep,
      basis: "notification",
      via: "crew",
      cause: true,
    });
    assert.deepStrictEqual(resolve(typed), { origin: "phone", basis: "stamp", reason: "typed" });
    assert.deepStrictEqual(resolve(oddDevice), {
      origin: "unknown",
      basis: "stamp",
      reason: "unknownDevice",
    });
    const journal = { origin: "phone", basis: "claim", reason: "journal", claim: "run" } as const;
    assert.deepStrictEqual(resolve(named), { ...journal, via: "agent" });
    assert.deepStrictEqual(resolve(followUp), { ...journal, via: "agent", cause: true });
    assert.deepStrictEqual(resolve(lostCause), {
      origin: "agent",
      basis: "notification",
      reason: "unnamedTurn",
    });
    assert.deepStrictEqual(resolve(workerWake), {
      origin: "agent",
      basis: "notification",
      reason: "unnamedTurn",
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
      yield* seedThread({ id: "firstmate", coordinator: true });
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
      // FirstMate's turns no claim named: a background command's wake, a turn with no prompt, and
      // one whose claim names a prompt that is gone. A worker launched in the wake inherits it.
      const backgroundUpdate = {
        createdBy: "agent",
        creationSource: "provider",
        notification: { source: { kind: "background_task" }, outcome: "updated" },
      };
      yield* seedRun({
        id: "fm-wake",
        ordinal: 3,
        threadId: "firstmate",
        sessionId: "fm-session",
        startedAt: "2026-08-07T04:20:00.000Z",
        message: backgroundUpdate,
      });
      yield* seedRun({
        id: "fm-silent",
        ordinal: 4,
        threadId: "firstmate",
        sessionId: "fm-session",
        startedAt: "2026-08-07T04:30:00.000Z",
      });
      yield* seedRun({
        id: "fm-lost",
        ordinal: 5,
        threadId: "firstmate",
        sessionId: "fm-session",
        startedAt: "2026-08-07T04:40:00.000Z",
        message: backgroundUpdate,
      });
      yield* claims.claim({
        target: { kind: "run", runId: "run-fm-lost" },
        value: {
          causedBy: { threadId: ThreadId.make("firstmate"), messageId: MessageId.make("gone") },
        },
      });
      yield* seedThread({
        id: "fm-worker",
        crewOf: "firstmate",
        causedBy: { threadId: "firstmate", messageId: "message-fm-wake" },
      });
      yield* seedRun({
        id: "fm-worker-brief",
        ordinal: 1,
        threadId: "fm-worker",
        sessionId: "fm-worker-session",
        startedAt: "2026-08-07T04:21:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
        },
      });
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

      // A session a phone-typed turn started in a terminal days before the window, still running.
      yield* seedThread({ id: "elder", createdAt: "2026-08-02T00:00:00.000Z" });
      yield* seedRun({
        id: "elder",
        ordinal: 1,
        threadId: "elder",
        sessionId: "elder-session",
        startedAt: "2026-08-02T00:00:00.000Z",
        completedAt: "2026-08-02T00:10:00.000Z",
        message: {
          createdBy: "user",
          creationSource: "web",
          origin: { surface: "web", deviceType: "mobile" },
        },
      });

      const origins = yield* UsageOrigins;
      const snapshot = yield* origins.read(
        Date.parse("2026-08-07T00:00:00.000Z"),
        Date.parse("2026-08-08T00:00:00.000Z"),
      );
      const index = new UsageOriginIndex(snapshot);
      // Root prompts have a case of their own below.
      const at = (sessionId: string, iso: string, cwd?: string) => {
        const { root: _root, ...key } = index.lookup({
          sessionId,
          timestampMs: Date.parse(iso),
          cwd,
        });
        return key;
      };
      assert.deepStrictEqual(at("lead-session", "2026-08-07T01:01:00Z"), {
        origin: "phone",
        basis: "stamp",
        reason: "typed",
      });
      const uncausedCrew = { origin: "crew", basis: "stamp", reason: "noCause" } as const;
      assert.deepStrictEqual(at("worker-session", "2026-08-07T01:06:00Z"), uncausedCrew);
      // Decided by following recorded causes, which the watchdog names.
      const viaCrew = {
        origin: "phone",
        basis: "stamp",
        via: "crew",
        reason: "inherited",
        cause: true,
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
      assert.deepStrictEqual(at("journal-session", "2026-08-07T01:51:00Z"), {
        ...journal,
        cause: true,
      });
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
        cause: true,
      });
      assert.deepStrictEqual(at("removed", "2026-08-07T03:00:00Z"), unregistered);
      const fromPhone = {
        origin: "phone",
        basis: "stamp",
        via: "agent",
        reason: "inherited",
        claim: "run",
        cause: true,
      } as const;
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:01:00Z"), fromPhone);
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:11:00Z"), fromPhone);
      const filed = { origin: "computer", reason: "upkeep" } as const;
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:21:00Z"), {
        ...filed,
        basis: "notification",
        via: "agent",
      });
      assert.deepStrictEqual(at("fm-worker-session", "2026-08-07T04:22:00Z"), {
        ...filed,
        basis: "notification",
        via: "crew",
        cause: true,
      });
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:31:00Z"), {
        ...filed,
        basis: "noPrompt",
      });
      assert.deepStrictEqual(at("fm-session", "2026-08-07T04:41:00Z"), {
        origin: "agent",
        basis: "notification",
        reason: "unnamedTurn",
      });
      assert.deepStrictEqual(at("scheduled-session", "2026-08-07T05:01:00Z"), {
        ...upkeep,
        via: "agent",
      });
      assert.deepStrictEqual(at("scheduled-worker-session", "2026-08-07T05:06:00Z"), {
        ...upkeep,
        via: "crew",
        cause: true,
      });
      assert.deepStrictEqual(at("worker-subagent-session", "2026-08-07T01:31:00Z"), uncausedCrew);
      const cyclePhone = { ...journal, via: "agent", cause: true } as const;
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
      assert.deepStrictEqual(at("elder-tmux", "2026-08-07T02:00:00Z"), {
        origin: "phone",
        basis: "stamp",
        reason: "typed",
        registered: true,
      });
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
          "agent/notification/-",
          "computer/claim/agent",
          "computer/claim/crew",
          "computer/notification/agent",
          "computer/notification/crew",
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
                      {
                        sessionId: "elder-tmux",
                        startedAt: "2026-08-02T00:05:00Z",
                        threadId: "elder",
                      },
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

describe("UsageOrigins born labelled", () => {
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
  const iso = (clock: string) => `2026-08-08T${clock}:00.000Z`;
  const time = (clock: string) => Date.parse(iso(clock));
  const run = (
    id: string,
    ordinal: number,
    threadId: string,
    from: string,
    to: string,
    message: Record<string, unknown>,
  ) =>
    seedRun({
      id,
      ordinal,
      threadId,
      sessionId: `${threadId}-session`,
      startedAt: iso(from),
      completedAt: iso(to),
      message,
    });

  it.effect(
    "binds launched work to its launcher's turn and moves it only with a typed message",
    () =>
      Effect.gen(function* () {
        const origins = yield* UsageOrigins;
        const bindAt = (clock: string) =>
          origins.originAt("firstmate", time(clock)).pipe(
            Effect.map((bound) => {
              assert.isNotNull(bound);
              return bound!;
            }),
          );
        const summary = (bound: BoundOrigin) =>
          `${bound.key.origin} ${bound.key.reason}${bound.reroots ? " reroots" : ""}`;
        yield* seedThread({ id: "firstmate", coordinator: true });

        // FirstMate launches a worker from a turn typed on the phone.
        yield* run("fm-phone", 1, "firstmate", "01:00", "01:10", phone);
        const launch = yield* bindAt("01:01");
        assert.strictEqual(summary(launch), "phone typed reroots");
        yield* seedThread({
          id: "worker",
          crewOf: "firstmate",
          createdAt: iso("01:01"),
          usageOrigin: storedOrigin(launch.key),
        });
        yield* run("brief", 1, "worker", "01:01", "01:30", fromMcp);
        // A scheduled task created in that turn.
        yield* origins.bindScheduledTask("task-daily", (yield* bindAt("01:02")).key);

        // In a later upkeep wake, a job that began in the phone turn still binds there.
        yield* run("fm-wake", 2, "firstmate", "02:00", "02:10", wake);
        assert.strictEqual(summary(yield* bindAt("02:01")), "computer upkeep");
        assert.strictEqual(summary(yield* bindAt("01:05")), "phone typed reroots");

        // A steer from a turn typed on the computer re-roots the worker from that moment.
        yield* run("worker-2", 2, "worker", "03:00", "03:30", wake);
        yield* run("fm-computer", 3, "firstmate", "03:10", "03:20", computer);
        const steer = yield* bindAt("03:11");
        assert.strictEqual(summary(steer), "computer typed reroots");
        yield* seedMessage({
          id: "steer",
          threadId: "worker",
          runId: "run-worker-2",
          createdAt: iso("03:11"),
          payload: { ...fromMcp, usageOrigin: storedOrigin(steer.key) },
        });
        yield* run("worker-3", 3, "worker", "04:00", "04:30", wake);

        // Settling the worker is a click: its note's turn counts to the worker, and moves nothing.
        yield* run("fm-settle", 4, "firstmate", "05:00", "05:10", {
          ...phone,
          crewNote: { threadId: "worker", kind: "action" },
        });
        assert.strictEqual(summary(yield* bindAt("05:01")), "computer inherited");
        // So a send in that turn carries no origin.
        yield* run("worker-4", 4, "worker", "05:02", "05:30", fromMcp);

        // A reply typed on the worker's box, from the phone, moves it back.
        yield* run("fm-reply", 5, "firstmate", "06:00", "06:10", {
          ...phone,
          crewNote: { threadId: "worker", kind: "reply" },
        });
        yield* run("worker-5", 5, "worker", "06:30", "06:40", wake);
        // A reply from the computer just after that turn ends moves what the worker launches then.
        yield* run("fm-reply-computer", 6, "firstmate", "06:42", "06:44", {
          ...computer,
          crewNote: { threadId: "worker", kind: "reply" },
        });
        const afterTurn = yield* origins.originAt("worker", time("06:43"));
        assert.strictEqual(afterTurn && summary(afterTurn), "computer inherited");

        // The scheduled task's run, in a thread of its own.
        yield* seedThread({ id: "daily", createdAt: iso("07:00") });
        yield* run("daily", 1, "daily", "07:00", "07:10", {
          createdBy: "agent",
          creationSource: "mcp",
          scheduledTaskId: "task-daily",
        });

        // FirstMate today: a launch and a steer that name a cause, which a typed one re-roots.
        yield* seedThread({
          id: "older",
          crewOf: "firstmate",
          createdAt: iso("01:00"),
          causedBy: { threadId: "firstmate", messageId: "message-fm-phone" },
        });
        yield* run("older-1", 1, "older", "01:30", "01:40", fromMcp);
        yield* run("older-2", 2, "older", "03:15", "03:16", {
          ...fromMcp,
          causedBy: { threadId: "firstmate", messageId: "message-fm-computer" },
        });
        yield* run("older-3", 3, "older", "04:10", "04:20", wake);
        // An origin stored before only devices were stored names no device: its cause decides.
        yield* seedThread({
          id: "agent-bound",
          crewOf: "firstmate",
          createdAt: iso("01:00"),
          causedBy: { threadId: "firstmate", messageId: "message-fm-phone" },
          usageOrigin: { origin: "agent", basis: "sender", reason: "noCause" },
        });
        yield* run("agent-bound-1", 1, "agent-bound", "01:30", "01:40", fromMcp);

        const index = new UsageOriginIndex(yield* origins.read(time("00:00"), time("23:59")));
        const counted = (threadId: string, clock: string) => {
          const key = index.lookup({ sessionId: `${threadId}-session`, timestampMs: time(clock) });
          return `${threadId} ${clock} ${key.origin} ${key.reason}`;
        };
        assert.deepStrictEqual(
          [
            counted("worker", "01:05"),
            counted("firstmate", "02:01"),
            counted("worker", "03:05"),
            counted("worker", "03:12"),
            counted("worker", "04:01"),
            counted("firstmate", "05:01"),
            counted("worker", "05:03"),
            counted("firstmate", "06:01"),
            counted("worker", "06:31"),
            counted("daily", "07:01"),
            counted("older", "01:31"),
            counted("older", "03:15"),
            counted("older", "04:11"),
            counted("agent-bound", "01:31"),
          ],
          [
            "worker 01:05 phone inherited",
            "firstmate 02:01 computer upkeep",
            "worker 03:05 phone inherited",
            "worker 03:12 computer inherited",
            "worker 04:01 computer inherited",
            "firstmate 05:01 computer inherited",
            "worker 05:03 computer inherited",
            "firstmate 06:01 phone typed",
            "worker 06:31 phone inherited",
            "daily 07:01 phone inherited",
            "older 01:31 phone inherited",
            "older 03:15 computer inherited",
            "older 04:11 computer inherited",
            "agent-bound 01:31 phone inherited",
          ],
        );
        // Deleting the scheduled task leaves its past runs counted where they were.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: "task-daily",
          title: "Daily",
          prompt: "Daily",
          enabled: 1,
          schedule_json: "{}",
          project_id: "project",
          workspace_strategy_json: "{}",
          model_selection_json: "{}",
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_by: "agent",
          creation_source: "mcp",
          created_at: iso("01:02"),
          updated_at: iso("01:02"),
          last_run_status: "never",
          run_count: 0,
        })}`;
        yield* sql`DELETE FROM scheduled_tasks WHERE task_id = 'task-daily'`;
        const afterDelete = new UsageOriginIndex(yield* origins.read(time("00:00"), time("23:59")));
        const daily = afterDelete.lookup({
          sessionId: "daily-session",
          timestampMs: time("07:01"),
        });
        assert.strictEqual(`${daily.origin} ${daily.reason}`, "phone inherited");
        assert.isNull(yield* origins.originAt("gone", time("01:00")));
      }).pipe(
        Effect.provide(
          usageOriginsLayer.pipe(
            Layer.provide(
              Layer.mock(UsageSessionRegister.UsageSessionRegister)({
                read: () => Effect.succeed([]),
              }),
            ),
            Layer.provideMerge(UsageClaims.layer),
            Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
          ),
        ),
      ),
  );

  it.effect(
    "binds children, continuations and claims by value, with the typed prompt at their root",
    () =>
      Effect.gen(function* () {
        const origins = yield* UsageOrigins;
        const claims = yield* UsageClaims.UsageClaims;
        // What the tools store: the calling thread's turn, bound by value.
        const bindAt = (threadId: string, clock: string) =>
          origins.originAt(threadId, time(clock)).pipe(
            Effect.map((bound) => {
              assert.isNotNull(bound);
              return bound!;
            }),
          );
        const bornAt = (threadId: string, clock: string) =>
          bindAt(threadId, clock).pipe(
            Effect.map((bound) => {
              const stored = storedOrigin(bound.key);
              assert.isDefined(stored);
              return stored!;
            }),
          );
        const rootOf = (key: { root?: { messageId: string } }) => key.root?.messageId ?? "-";
        yield* seedThread({ id: "firstmate", coordinator: true });

        // A worker launched from a phone turn, then steered from a computer turn.
        yield* run("fm-phone", 1, "firstmate", "01:00", "01:10", phone);
        const worker = yield* bornAt("firstmate", "01:01");
        assert.strictEqual(rootOf(worker), "message-fm-phone");
        yield* seedThread({
          id: "worker",
          crewOf: "firstmate",
          createdAt: iso("01:01"),
          usageOrigin: worker,
        });
        yield* run("w1", 1, "worker", "01:01", "01:30", fromMcp);
        yield* run("fm-computer", 2, "firstmate", "02:00", "02:10", computer);
        const steer = yield* bindAt("firstmate", "02:01");
        yield* run("w2", 2, "worker", "02:01", "02:20", {
          ...fromMcp,
          usageOrigin: storedOrigin(steer.key),
        });
        // In that turn the worker delegates a child: born where the worker counts now, not
        // where it was born.
        const child = yield* bornAt("worker", "02:05");
        yield* seedThread({ id: "child", createdAt: iso("02:05"), usageOrigin: child });
        yield* run("child-1", 1, "child", "02:05", "02:15", wake);

        // A thread he typed on his phone creates a thread, which delegates one in turn.
        yield* seedThread({ id: "mine", createdAt: iso("03:00") });
        yield* run("mine-1", 1, "mine", "03:00", "03:30", phone);
        const created = yield* bornAt("mine", "03:05");
        yield* seedThread({ id: "created", createdAt: iso("03:05"), usageOrigin: created });
        yield* run("created-1", 1, "created", "03:05", "03:20", fromMcp);
        const grandchild = yield* bornAt("created", "03:10");
        yield* seedThread({ id: "grandchild", createdAt: iso("03:10"), usageOrigin: grandchild });
        yield* run("grandchild-1", 1, "grandchild", "03:10", "03:15", wake);
        // FirstMate names a wake for that work: the claim keeps its root too.
        yield* run("fm-wake", 4, "firstmate", "03:25", "03:30", wake);
        const { origin: device, ...binding } = yield* bornAt("created", "03:25");
        assert.isTrue(device === "phone");
        yield* claims.claim({
          target: { kind: "run", runId: "run-fm-wake" },
          value: { device: "phone", bound: binding },
        });

        // A reply typed on the worker's box from the phone moves it while no turn of it runs.
        yield* run("fm-reply", 3, "firstmate", "03:00", "03:02", {
          ...phone,
          crewNote: { threadId: "worker", kind: "reply" },
        });

        // A phone turn the restart cut, and its continuation, bound as the server binds it.
        yield* run("fm-cut", 5, "firstmate", "04:00", "04:05", phone);
        const resumed = yield* bornAt("firstmate", "04:05");
        const restarted = { createdBy: "agent", creationSource: "server", notification: {} };
        yield* run("fm-cont", 6, "firstmate", "04:06", "04:10", {
          ...restarted,
          usageOrigin: resumed,
        });
        // A continuation in the worker counts where it was bound, and moves nothing.
        yield* run("w-cont", 3, "worker", "05:00", "05:05", {
          ...restarted,
          usageOrigin: storedOrigin(steer.key),
        });
        yield* run("w4", 4, "worker", "06:00", "06:10", wake);

        // The bedtime routine, launched as upkeep inside the phone turn.
        yield* seedThread({
          id: "nightly",
          crewOf: "firstmate",
          createdAt: iso("01:02"),
          usageOrigin: storedOrigin(LAUNCHED_UPKEEP),
        });
        yield* run("nightly-1", 1, "nightly", "01:02", "01:20", fromMcp);
        yield* run("nightly-2", 2, "nightly", "05:00", "05:10", wake);
        // A wake about it, claimed with the worker's own thread.
        yield* run("fm-nightly-wake", 7, "firstmate", "07:00", "07:05", wake);
        const { origin: nightlyDevice, ...nightlyBinding } = yield* bornAt("nightly", "07:00");
        assert.isTrue(nightlyDevice === "computer");
        yield* claims.claim({
          target: { kind: "run", runId: "run-fm-nightly-wake" },
          value: { device: "computer", bound: nightlyBinding },
        });

        const snapshot = yield* origins.read(time("00:00"), time("23:59"));
        // Sessions T3 does not run: reviews the worker and FirstMate started.
        const index = new UsageOriginIndex({
          ...snapshot,
          registrations: [
            { sessionId: "review", startedAtMs: time("02:06"), threadId: "worker" },
            { sessionId: "fm-review", startedAtMs: time("02:01"), threadId: "firstmate" },
          ],
        });
        const counted = (sessionId: string, clock: string) => {
          const key = index.lookup({ sessionId, timestampMs: time(clock) });
          return `${sessionId} ${clock} ${key.origin} ${key.reason} ${rootOf(key)}${key.registered ? " registered" : ""}`;
        };
        assert.deepStrictEqual(
          [
            counted("child-session", "02:06"),
            counted("created-session", "03:06"),
            counted("grandchild-session", "03:11"),
            counted("firstmate-session", "03:26"),
            // 30 minutes after the worker's turn ended, then after the reply moved it.
            counted("worker-session", "02:50"),
            counted("worker-session", "03:40"),
            counted("review", "02:30"),
            counted("review", "03:10"),
            counted("fm-review", "03:10"),
            counted("firstmate-session", "04:07"),
            counted("worker-session", "05:01"),
            counted("worker-session", "06:01"),
          ],
          [
            "child-session 02:06 computer inherited message-fm-computer",
            "created-session 03:06 phone inherited message-mine-1",
            "grandchild-session 03:11 phone inherited message-mine-1",
            "firstmate-session 03:26 phone inherited message-mine-1",
            "worker-session 02:50 computer inherited message-fm-computer",
            "worker-session 03:40 phone inherited message-fm-reply",
            "review 02:30 computer inherited message-fm-computer registered",
            "review 03:10 phone inherited message-fm-reply registered",
            "fm-review 03:10 computer typed message-fm-computer registered",
            "firstmate-session 04:07 phone inherited message-fm-cut",
            "worker-session 05:01 computer inherited message-fm-computer",
            "worker-session 06:01 phone inherited message-fm-reply",
          ],
        );
        const upkeep = [
          index.lookup({ sessionId: "nightly-session", timestampMs: time("01:05") }),
          index.lookup({ sessionId: "nightly-session", timestampMs: time("05:01") }),
          index.lookup({ sessionId: "firstmate-session", timestampMs: time("07:01") }),
        ];
        assert.deepStrictEqual(
          upkeep.map((key) => `${key.origin} ${key.basis} ${key.reason}`),
          ["computer claim upkeep", "computer claim upkeep", "computer claim upkeep"],
        );
        assert.isFalse(upkeep.some((key) => usageOriginCountsByDefault(key.reason)));
        // Bound by value: nothing here followed a recorded cause.
        assert.isFalse(snapshot.turns.some((turn) => turn.key.cause === true));
      }).pipe(
        Effect.provide(
          usageOriginsLayer.pipe(
            Layer.provide(
              Layer.mock(UsageSessionRegister.UsageSessionRegister)({
                read: () => Effect.succeed([]),
              }),
            ),
            Layer.provideMerge(UsageClaims.layer),
            Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
          ),
        ),
      ),
  );
});

describe("UsageOrigins daily close", () => {
  const phone = {
    createdBy: "user",
    creationSource: "web",
    origin: { surface: "web", deviceType: "mobile" },
  };
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
  // After T3 began recording devices, which is where closes start.
  const iso = (clock: string) => `2026-11-20T${clock}:00.000Z`;
  const time = (clock: string) => Date.parse(iso(clock));
  const run = (
    id: string,
    ordinal: number,
    threadId: string,
    from: string,
    to: string,
    message: Record<string, unknown>,
  ) =>
    seedRun({
      id,
      ordinal,
      threadId,
      sessionId: `${threadId}-session`,
      startedAt: iso(from),
      completedAt: iso(to),
      message,
    });
  const label = (key: UsageOriginKey | undefined) =>
    key === undefined
      ? "none"
      : `${key.origin} ${key.reason}${key.claim === undefined ? "" : ` ${key.claim} claim`}${key.folder ? " folder" : ""} ${key.root?.messageId ?? "-"}`;
  const layer = usageOriginsLayer.pipe(
    Layer.provide(
      Layer.mock(UsageSessionRegister.UsageSessionRegister)({ read: () => Effect.succeed([]) }),
    ),
    Layer.provideMerge(UsageClaims.layer),
    Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
  );

  it.effect(
    "writes a day's labels down once, and a later claim or bind reads what was written",
    () =>
      Effect.gen(function* () {
        const origins = yield* UsageOrigins;
        const claims = yield* UsageClaims.UsageClaims;
        yield* seedThread({ id: "firstmate", coordinator: true });
        // A worker launched from a turn typed on the phone, and a later upkeep wake.
        yield* run("fm-phone", 1, "firstmate", "01:00", "01:10", phone);
        const launch = yield* origins.originAt("firstmate", time("01:01"));
        yield* seedThread({
          id: "worker",
          crewOf: "firstmate",
          createdAt: iso("01:01"),
          usageOrigin: storedOrigin(launch!.key),
        });
        yield* run("w1", 1, "worker", "01:01", "01:30", fromMcp);
        yield* run("fm-wake", 2, "firstmate", "02:00", "02:10", wake);
        const records = [
          { sessionId: "firstmate-session", timestampMs: time("01:05") },
          { sessionId: "firstmate-session", timestampMs: time("01:12") },
          { sessionId: "firstmate-session", timestampMs: time("02:05") },
          { sessionId: "worker-session", timestampMs: time("01:10") },
          { sessionId: "worker-session", timestampMs: time("01:45") },
          { sessionId: "worker-session", timestampMs: time("02:30") },
        ];
        // Binding in a turn, just after one ended (the grace), and well after.
        const bindTimes = [
          ["firstmate", "01:05"],
          ["firstmate", "01:12"],
          ["firstmate", "01:40"],
          ["firstmate", "02:05"],
          ["worker", "01:10"],
          ["worker", "01:33"],
          ["worker", "01:50"],
        ] as const;
        const bindAll = Effect.forEach(bindTimes, ([threadId, clock]) =>
          origins.originAt(threadId, time(clock)),
        );
        const boundBefore = yield* bindAll;
        const live = new UsageOriginIndex(yield* origins.read(time("00:00"), time("23:59")));

        const closed = yield* origins.close(time("12:00"), records);
        assert.deepStrictEqual(closed, {
          closed: true,
          span: { fromMs: Date.parse(USAGE_ORIGINS_RECORDED_SINCE), throughMs: time("12:00") },
          records: 6,
          // A row where each turn's label starts and ends; records inside them add none.
          sessionRows: 6,
          promptRows: 3,
          // Nothing was labelled at birth here, so there is nothing to check.
          born: null,
        });
        // A second close of the same time writes nothing.
        assert.deepStrictEqual(yield* origins.close(time("12:00"), records), {
          closed: false,
          why: "notDue",
        });

        // A claim made after the day closed: the live reader moves, the closed day does not.
        yield* claims.claim({
          target: { kind: "run", runId: "run-fm-wake" },
          value: { device: "phone" },
        });
        const span = yield* origins.closedSpan;
        assert.isNotNull(span);
        const stored = yield* origins.readClosed({
          span: span!,
          sessionIds: ["firstmate-session", "worker-session"],
          sinceMs: time("00:00"),
          untilMs: time("23:59"),
        });
        const relabelled = new UsageOriginIndex(yield* origins.read(time("00:00"), time("23:59")));
        assert.deepStrictEqual(
          records.map((record) => [
            label(stored.labels.labelAt(record)),
            label(live.lookup(record)),
            label(relabelled.lookup(record)),
          ]),
          [
            [
              "phone typed message-fm-phone",
              "phone typed message-fm-phone",
              "phone typed message-fm-phone",
            ],
            [
              "phone typed message-fm-phone",
              "phone typed message-fm-phone",
              "phone typed message-fm-phone",
            ],
            ["computer upkeep -", "computer upkeep -", "phone journal run claim -"],
            [
              "phone inherited message-fm-phone",
              "phone inherited message-fm-phone",
              "phone inherited message-fm-phone",
            ],
            [
              "phone inherited message-fm-phone",
              "phone inherited message-fm-phone",
              "phone inherited message-fm-phone",
            ],
            [
              "phone inherited message-fm-phone",
              "phone inherited message-fm-phone",
              "phone inherited message-fm-phone",
            ],
          ],
        );
        assert.strictEqual(stored.prompts.length, 3);
        // Binding at a closed time answers from the stored labels, as it answered before.
        assert.deepStrictEqual(yield* bindAll, boundBefore);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("closes one session's records in two folders at the same moment", () =>
    Effect.gen(function* () {
      const origins = yield* UsageOrigins;
      yield* seedThread({ id: "worker", worktreePath: "/wt/worker", createdAt: iso("01:00") });
      yield* run("w1", 1, "worker", "01:00", "01:30", phone);
      const records = [
        { sessionId: "stray", timestampMs: time("01:10"), cwd: "/wt/worker/src" },
        { sessionId: "stray", timestampMs: time("01:10"), cwd: "/elsewhere" },
      ];
      const live = new UsageOriginIndex(yield* origins.read(time("00:00"), time("23:59")));
      assert.notStrictEqual(label(live.lookup(records[0]!)), label(live.lookup(records[1]!)));
      // One label per time cannot hold both, so it holds the first; the close still moves on.
      const outcome = yield* origins.close(time("12:00"), records);
      assert.include(outcome, { closed: true });
      const stored = yield* origins.readClosed({
        span: (yield* origins.closedSpan)!,
        sessionIds: ["stray"],
        sinceMs: time("00:00"),
        untilMs: time("23:59"),
      });
      assert.deepStrictEqual(
        records.map((record) => label(stored.labels.labelAt(record))),
        [label(live.lookup(records[0]!)), label(live.lookup(records[0]!))],
      );
    }).pipe(Effect.provide(layer)),
  );
});
