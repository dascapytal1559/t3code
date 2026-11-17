// @effect-diagnostics nodeBuiltinImport:off - reads the log files the test writes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import {
  LIMITS_LOG_FOLDER_NAME,
  makeLimitsLog,
  providerReadings,
  sourceReadings,
} from "./UsageLimitsLog.ts";

const claude = (checkedAt: string, sessionPercent: number, resetsAt = "2026-11-20T05:00:00Z") =>
  ({
    driver: ProviderDriverKind.make("claude"),
    instanceId: ProviderInstanceId.make("claude"),
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    checkedAt,
    auth: { status: "authenticated", email: "someone@example.com" },
    models: [],
    skills: [],
    slashCommands: [],
    usageLimits: {
      checkedAt,
      credentialFingerprint: "fingerprint-not-for-the-log",
      windows: [
        { id: "five-hour", kind: "session", label: "5h", usedPercent: sessionPercent, resetsAt },
        { id: "seven-day", kind: "weekly", label: "Week", usedPercent: 12 },
      ],
    },
  }) satisfies ServerProvider;

const unavailable = {
  ...claude("2026-11-17T01:00:00Z", 0),
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  usageLimits: {
    checkedAt: "2026-11-17T01:00:00Z",
    windows: [],
    unavailable: { reason: "probeFailed" },
  },
} satisfies ServerProvider;

const proxied = [
  {
    id: UsageLimitSourceId.make("proxy"),
    kind: "cliproxy",
    label: "Proxy",
    checkedAt: "2026-11-17T01:00:00Z",
    accounts: [
      {
        id: "account-1",
        driver: ProviderDriverKind.make("codex"),
        email: "other@example.com",
        usageLimits: {
          checkedAt: "2026-11-17T01:00:00Z",
          windows: [{ id: "weekly", kind: "weekly", label: "Week", usedPercent: 70 }],
        },
      },
    ],
  },
] satisfies UsageLimitSourceSnapshot[];

describe("usage limits log", () => {
  it.effect("appends readings that move a figure, quiet accounts hourly, one file per month", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-log-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const log = yield* makeLimitsLog.pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      for (const providers of [
        [claude("2026-11-17T01:00:00Z", 40), unavailable],
        // The same reading again, then a refresh whose reset jittered across the minute.
        [claude("2026-11-17T01:00:00Z", 40)],
        [claude("2026-11-17T01:05:00Z", 40, "2026-11-20T04:59:59.857Z")],
        [claude("2026-11-17T01:10:00Z", 41)],
        [claude("2026-11-17T02:00:00Z", 41)],
        [claude("2026-11-17T02:15:00Z", 41)],
        [claude("2026-12-01T00:00:00Z", 2)],
      ]) {
        yield* log.append(providerReadings(providers));
      }
      yield* log.append(sourceReadings(proxied));

      const folder = NodePath.join(baseDir, "userdata", LIMITS_LOG_FOLDER_NAME);
      const read = (name: string) => NodeFS.readFileSync(NodePath.join(folder, name), "utf8");
      const november = read("2026-11.jsonl");
      assert.notInclude(november, "fingerprint-not-for-the-log");
      const lines = november
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepStrictEqual(lines[0], {
        v: 1,
        at: "2026-11-17T01:00:00Z",
        provider: "claude",
        instanceId: "claude",
        account: "someone@example.com",
        windows: [
          {
            id: "five-hour",
            kind: "session",
            label: "5h",
            usedPercent: 40,
            resetsAt: "2026-11-20T05:00:00Z",
          },
          { id: "seven-day", kind: "weekly", label: "Week", usedPercent: 12 },
        ],
      });
      assert.deepStrictEqual(
        lines.map((line) => [line.at, line.provider, line.windows[0].usedPercent]),
        [
          ["2026-11-17T01:00:00Z", "claude", 40],
          ["2026-11-17T01:10:00Z", "claude", 41],
          // An hour after the last line, with nothing moved.
          ["2026-11-17T02:15:00Z", "claude", 41],
          ["2026-11-17T01:00:00Z", "codex", 70],
        ],
      );
      assert.deepStrictEqual(lines[3], {
        v: 1,
        at: "2026-11-17T01:00:00Z",
        provider: "codex",
        source: "Proxy",
        account: "other@example.com",
        windows: [{ id: "weekly", kind: "weekly", label: "Week", usedPercent: 70 }],
      });
      assert.include(read("2026-12.jsonl"), '"at":"2026-12-01T00:00:00Z"');
    }).pipe(Effect.scoped),
  );
});
