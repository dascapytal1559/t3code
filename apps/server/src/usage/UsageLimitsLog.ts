import type {
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import { registerFileNames } from "./UsageSessionRegister.ts";

export const LIMITS_LOG_FOLDER_NAME = "usage-limits";

const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A quiet account still gets a line this often while readings come in. */
const QUIET_READING_MS = 60 * 60 * 1000;

/** One line of the limits log: an account's limit windows as one refresh read them. */
export interface LimitsReading {
  readonly v: 1;
  readonly at: string;
  readonly provider: string;
  readonly instanceId?: string;
  /** The limit source's label, for accounts read through one (CLIProxyAPI). */
  readonly source?: string;
  readonly account?: string;
  readonly windows: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt?: string;
    readonly windowDurationMins?: number;
  }[];
}

export interface KeyedReading {
  /** One account as T3 reads it; readings of one key compare with each other. */
  readonly key: string;
  readonly reading: LimitsReading;
}

const readingOf = (
  limits: ServerProviderUsageLimits | undefined,
  fields: Omit<LimitsReading, "v" | "at" | "windows">,
): LimitsReading | null =>
  limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0
    ? null
    : {
        v: 1,
        at: limits.checkedAt,
        ...fields,
        windows: limits.windows.map((window) => ({
          id: window.id,
          kind: window.kind,
          label: window.label,
          usedPercent: window.usedPercent,
          ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
          ...(window.windowDurationMins === undefined
            ? {}
            : { windowDurationMins: window.windowDurationMins }),
        })),
      };

export function providerReadings(providers: ReadonlyArray<ServerProvider>): KeyedReading[] {
  return providers.flatMap((provider) => {
    const account = provider.auth.email ?? provider.auth.label;
    const reading = readingOf(provider.usageLimits, {
      provider: provider.driver,
      instanceId: provider.instanceId,
      ...(account === undefined ? {} : { account }),
    });
    return reading === null ? [] : [{ key: `instance\0${provider.instanceId}`, reading }];
  });
}

export function sourceReadings(sources: ReadonlyArray<UsageLimitSourceSnapshot>): KeyedReading[] {
  return sources.flatMap((source) =>
    source.accounts.flatMap((account) => {
      const reading = readingOf(account.usageLimits, {
        provider: account.driver,
        source: source.label,
        account: account.email ?? account.id,
      });
      return reading === null ? [] : [{ key: `source\0${source.id}\0${account.id}`, reading }];
    }),
  );
}

// Reset times jitter by up to a second between reads, across minute boundaries too.
const RESET_JITTER_MS = 60 * 1000;
const resetMs = (resetsAt: string | undefined) =>
  resetsAt === undefined ? null : Date.parse(resetsAt);

function sameFigures(a: LimitsReading, b: LimitsReading): boolean {
  return (
    a.windows.length === b.windows.length &&
    a.windows.every((window, index) => {
      const other = b.windows[index]!;
      const [resetA, resetB] = [resetMs(window.resetsAt), resetMs(other.resetsAt)];
      return (
        window.id === other.id &&
        window.usedPercent === other.usedPercent &&
        (resetA === null || resetB === null
          ? resetA === resetB
          : Math.abs(resetA - resetB) < RESET_JITTER_MS)
      );
    })
  );
}

/**
 * Appends readings that move a figure, or that keep a quiet account's line hourly, to one file
 * per UTC month beside the session register.
 */
export const makeLimitsLog = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(config.stateDir, LIMITS_LOG_FOLDER_NAME);
  const logged = new Map<string, { readonly atMs: number; readonly reading: LimitsReading }>();
  const lock = yield* Semaphore.make(1);

  const append = Effect.fn("UsageLimitsLog.append")(function* (readings: readonly KeyedReading[]) {
    const due = new Map<string, { atMs: number; reading: LimitsReading }>();
    const lines = new Map<string, string[]>();
    for (const { key, reading } of readings) {
      const atMs = Date.parse(reading.at);
      if (Number.isNaN(atMs)) continue;
      const last = logged.get(key);
      if (
        last !== undefined &&
        (atMs <= last.atMs ||
          (atMs - last.atMs < QUIET_READING_MS && sameFigures(reading, last.reading)))
      ) {
        continue;
      }
      due.set(key, { atMs, reading });
      const file = registerFileNames(atMs, atMs)[0]!;
      lines.set(file, [...(lines.get(file) ?? []), `${encodeLine(reading)}\n`]);
    }
    if (lines.size === 0) return;
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    for (const [file, text] of lines) {
      yield* fileSystem.writeFileString(path.join(folder, file), text.join(""), { flag: "a" });
    }
    for (const [key, entry] of due) logged.set(key, entry);
  }, lock.withPermits(1));

  return { append } as const;
});

/** Logs every limits refresh of providers and limit sources; T3 keeps no other history of them. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const log = yield* makeLimitsLog;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const record = (readings: readonly KeyedReading[]) =>
      log
        .append(readings)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not append to the usage limits log.", cause),
          ),
        );
    yield* Stream.concat(Stream.fromEffect(providers.getProviders), providers.streamChanges).pipe(
      Stream.runForEach((snapshot) => record(providerReadings(snapshot))),
      Effect.forkScoped,
    );
    yield* Stream.concat(Stream.fromEffect(sources.current), sources.streamChanges).pipe(
      Stream.runForEach((snapshot) => record(sourceReadings(snapshot))),
      Effect.forkScoped,
    );
  }),
);
