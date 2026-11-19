import {
  type ProjectId,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsageExportRecord,
  type UsageOriginReasonUsage,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageCloseResult,
  UsageDay,
  UsageReadError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { formatMalformedUsageWarning } from "@t3tools/shared/usageFormat";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_USAGE_DRIVERS, type BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type {
  ProviderUsageInstance,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  canonicalModelFilter,
  resolveModelAliases,
  toUsageExportRecord,
  UsageAggregator,
  type CountedRecord,
} from "./usageAggregation.ts";
import * as UsageClose from "./UsageClose.ts";
import * as UsageOrigins from "./UsageOrigins.ts";
import {
  groupsPlaceWork,
  makeUsageWork,
  sharedWorkOf,
  USAGE_SESSION_FOLDERS_FILE_NAME,
  type WorkFolders,
  type WorkWorktree,
} from "./usageWork.ts";
import { readUsageAnnotations, USAGE_ANNOTATIONS_FILE_NAME } from "./usageAnnotations.ts";
import {
  discoverUsageArchive,
  upgradeArchivedScanCache,
  type ArchivedScanCache,
  type UsageArchiveLabel,
} from "./usageArchive.ts";
import {
  createOverrideRateTable,
  isUnlistedModel,
  parseRateTable,
  type RateTable,
} from "./usagePricing.ts";
import {
  DESKTOP_HOST_SCOPE_ENV,
  listTranscriptFiles,
  readDirectoryVolumeId,
  readPhysicalSourceId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

// mtime slack includes writes just before local midnight on the window's first day.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const STALE_TEMP_DIRECTORY_MS = 60 * 60 * 1000;

const TRANSCRIPT_READ_CONCURRENCY = 4;

const transcriptReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "transcripts" ? [{ driver, reader: driver.usage }] : [],
);

const scanReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "scan" ? [{ driver, reader: driver.usage }] : [],
);

const providerRateModels = new Map(
  BUILT_IN_USAGE_DRIVERS.flatMap(({ usage }) =>
    usage?.rateModel === undefined ? [] : [[usage.provider, usage.rateModel] as const],
  ),
);

const transcriptFormats = new Map(
  transcriptReaders.map(({ reader }) => [reader.provider, reader.format] as const),
);

interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly physicalSourceId?: string;
  readonly fileName?: string;
  readonly archive?: UsageArchiveLabel;
}

const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(Schema.fromJsonString(RatesCacheFile));
const encodeRatesCache = Schema.encodeEffect(Schema.fromJsonString(RatesCacheFile));

const ScanCacheJson = Schema.fromJsonString(Schema.Unknown);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });

function isLaterRead(a: CachedFile, b: CachedFile): boolean {
  return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);
}

const sharedSessionProviders: ReadonlySet<UsageProviderKind> = new Set(
  transcriptReaders.flatMap(({ reader }) =>
    reader.format.sharedSessionsAcrossFiles ? [reader.provider] : [],
  ),
);

// Only shared sessions need cross-file dedupe; per-file occurrence counts make other keys unique.
function sharedSessions(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (!sharedSessionProviders.has(provider) || sessionId === previous || sessionId.length === 0)
        continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}
const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({
    sources: Schema.Record(Schema.String, CachedSource),
    coveredSince: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  }),
);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    /** The window's usage by why it counts to the phone or computer; fails when origins are unreadable. */
    readonly readOriginReasons: (
      input: Pick<UsageSummaryInput, "sinceDay" | "untilDay" | "timeZone">,
    ) => Effect.Effect<readonly UsageOriginReasonUsage[], UsageReadError>;
    /** The window's records one by one, oldest first, as the summary counts them. */
    readonly readRecords: (
      input: Pick<UsageSummaryInput, "sinceDay" | "untilDay" | "timeZone">,
    ) => Effect.Effect<readonly UsageExportRecord[], UsageReadError>;
    readonly refreshRates: Effect.Effect<UsagePricing>;
    /**
     * Closes Usage's labels now through `throughMs`, as the daily close would, instead of waiting
     * for it; the daily close continues from there. A dry run says what it would write.
     */
    readonly closeThrough: (input: {
      readonly throughMs: number;
      readonly dryRun: boolean;
    }) => Effect.Effect<UsageCloseResult, UsageClose.UsageCloseError>;
  }
>()("t3/usage/UsageService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const hostScope = hostEnvironment[DESKTOP_HOST_SCOPE_ENV]?.trim();
  // A mount or a directory's on-disk name does not change under a running server.
  // A miss is not cached: the directory may not exist yet.
  const physicalSourceIds = new Map<string, Promise<string | undefined>>();
  const physicalSourceId = (dir: string) =>
    Effect.promise(() => {
      const cached = physicalSourceIds.get(dir);
      if (cached !== undefined) return cached;
      const id = readPhysicalSourceId(dir, hostScope, hostPlatform);
      physicalSourceIds.set(dir, id);
      void id.then((resolved) => {
        if (resolved === undefined && physicalSourceIds.get(dir) === id) {
          physicalSourceIds.delete(dir);
        }
      });
      return id;
    });
  const hostname = yield* HostProcess.Hostname;
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();
  const usageOrigins = yield* UsageOrigins.UsageOrigins;
  const sql = yield* SqlClient.SqlClient;

  const fileCache: ScanCache = new Map();
  // Reads from concurrent windows can still hold the original record after it is corrected.
  const resolvedRecords = new WeakMap<UsageRecord, UsageRecord>();
  const correctedRecord = (record: UsageRecord) => resolvedRecords.get(record) ?? record;
  const correctedBatch = (records: readonly UsageRecord[]) =>
    records.some((record) => resolvedRecords.has(record)) ? records.map(correctedRecord) : records;
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  // Earliest window start a complete scan read each transcript directory from.
  const coveredSince = new Map<string, number>();
  const coverageKey = (source: TranscriptSource) => `${source.provider}\0${source.dir}`;
  let cacheDirty = false;
  const cover = (source: TranscriptSource, windowStartMs: number) => {
    if ((coveredSince.get(coverageKey(source)) ?? Infinity) <= windowStartMs) return;
    coveredSince.set(coverageKey(source), windowStartMs);
    cacheDirty = true;
  };
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, SCAN_CACHE_FILE_NAME);
  const writeCacheFile = (filePath: string, contents: string | Iterable<string>) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const hostIdPath = path.join(config.baseDir, "usage-host-id");
  const explicitHostId = hostEnvironment["T3CODE_HOST_ID"]?.trim();
  const hostId =
    explicitHostId ||
    (yield* fileSystem.readFileString(hostIdPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* fileSystem.makeDirectory(config.baseDir, { recursive: true });
              const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
                directory: config.baseDir,
                prefix: "usage-host-id.",
              });
              const tempFile = path.join(tempDirectory, "identity");
              yield* fileSystem.writeFileString(tempFile, `${hostname}\n`);
              // Publish complete contents without replacing another initializer's identity.
              yield* fileSystem.link(tempFile, hostIdPath).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists",
                  () => Effect.void,
                ),
              );
              return yield* fileSystem.readFileString(hostIdPath);
            }),
          ),
      ),
      Effect.map((value) => value.trim() || hostname),
      Effect.orElseSucceed(() => hostname),
    ));
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesLastFailedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  const fetchRates = (url: string, accept = "application/json") =>
    httpClient.get(url, { headers: { accept } }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((document) => {
        const parsed = parseRateTable(document);
        return parsed.size > 0 ? { document, parsed } : null;
      }),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  // Outside ratesLock, which a slow fetch holds: a provisional answer prices with these.
  const loadSavedRates = yield* Effect.cached(
    fileSystem.readFileString(ratesCachePath).pipe(
      Effect.flatMap((raw) => decodeRatesCache(raw)),
      Effect.map((saved) => {
        const parsed = parseRateTable(saved.document);
        if (parsed.size === 0) return;
        rates = parsed;
        ratesFetchedAtMs = saved.fetchedAtMs;
        ratesStatus = "cached";
      }),
      Effect.ignoreCause,
    ),
  );

  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    yield* loadSavedRates;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;
    if (ratesLastFailedAtMs !== null && now - ratesLastFailedAtMs < RATES_REFRESH_FLOOR_MS) return;

    let fetched = yield* fetchRates(LITELLM_RATES_URL);
    if (fetched === null) {
      fetched = yield* fetchRates(LITELLM_RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (fetched === null) {
      ratesLastFailedAtMs = yield* Clock.currentTimeMillis;
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    rates = fetched.parsed;
    ratesFetchedAtMs = now;
    ratesLastFailedAtMs = null;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched.document }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  // Rates are kept for RATES_TTL_MS, so a model released after the table was fetched would stay unpriced
  // that long. A scan that meets a model the table does not list refetches early: once per model against
  // a fresh table, with loadRates keeping RATES_REFRESH_FLOOR_MS between attempts.
  const checkedUnlistedModels = new Set<string>();
  const refreshForUnlistedModels = Effect.fn("UsageService.refreshForUnlistedModels")(function* (
    models: ReadonlySet<string>,
  ) {
    const unlisted = [...models].filter(
      (model) => !checkedUnlistedModels.has(model) && isUnlistedModel(rates, model),
    );
    if (unlisted.length === 0) return;
    yield* ensureRates(true);
    const now = yield* Clock.currentTimeMillis;
    // A failed fetch leaves the models unchecked, so a later scan tries again.
    if (ratesFetchedAtMs === null || now - ratesFetchedAtMs >= RATES_REFRESH_FLOOR_MS) return;
    for (const model of unlisted) checkedUnlistedModels.add(model);
  });

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  const usageInstances = Effect.fn("UsageService.usageInstances")(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: ServerSettingsValue,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    // History in the driver's default home stays counted after every instance moves elsewhere; readers dedupe shared directories.
    entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    const decodeConfig = Schema.decodeUnknownOption(driver.configSchema);
    return yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([instanceId, instance, configured]) {
        const instanceConfig: ProviderUsageInstance<Config> = {
          instanceId,
          config: Option.getOrUndefined(decodeConfig(instance.config ?? {})),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ),
          configured,
        };
        return instanceConfig;
      }),
    );
  });

  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
  ) {
    const dirs: Array<TranscriptSource> = [];
    const pending: Array<ScannedDir> = [];
    const seen = new Set<string>();
    for (const { driver, reader } of transcriptReaders) {
      const { provider, format } = reader;
      const directories = yield* Effect.forEach(
        yield* usageInstances(driver, settings),
        (instance) => reader.directories(instance, { awaitRefresh }),
      );
      for (const { dir: directory, fileName, refreshing } of directories.flat()) {
        if (refreshing) {
          const key = `${provider}\0${directory}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pending.push({ provider, dir: directory, volumeId: "", files: [], refreshing });
          continue;
        }
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const hasRetainedHistory = fileCache
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              (entry.records.length + entry.tailRecords.length > 0 || entry.malformedRecords > 0) &&
              isWithinDirectory(filePath, dir),
          );
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          cacheDirty = true;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceId = yield* physicalSourceId(dir);
        dirs.push({
          provider,
          format,
          dir,
          volumeId,
          ...(sourceId === undefined ? {} : { physicalSourceId: sourceId }),
          ...(fileName === undefined ? {} : { fileName }),
        });
      }
    }
    return { dirs, pending };
  });

  // Share first loads so concurrent readers cannot scan against a still-empty cache.
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const readDocument = (filePath: string) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.flatMap((raw) => decodeScanCacheFile(raw)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
      let document = yield* readDocument(scanCachePath);
      const current = document !== null;
      for (const fileName of LEGACY_SCAN_CACHE_FILE_NAMES) {
        if (document !== null) break;
        document = yield* readDocument(path.join(config.stateDir, fileName));
        cacheDirty = document !== null;
      }
      if (document === null) return;
      const decoded = decodeScanCache(document, transcriptFormats);
      for (const [path, entry] of decoded) fileCache.set(path, entry);
      const saved = (document as { readonly files?: unknown }).files;
      const complete =
        typeof saved === "object" && saved !== null && Object.keys(saved).length === decoded.size;
      const sources = decodeCachedSources(document);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
        // Coverage describes the saved files, so it needs every one, in this version's format.
        if (current && complete && fileCache.size > 0) {
          for (const [key, since] of Object.entries(sources.value.coveredSince ?? {}))
            coveredSince.set(key, since);
        }
      }
    }),
  );

  const writeScanCache = makeScanCacheWriter();
  // Serialize writes so concurrently finished window scans cannot overwrite newer snapshots.
  const persistLock = yield* Semaphore.make(1);

  // The saved cache supersedes older versions. Temp folders an aborted write left behind are
  // removed once idle for an hour, so a write in progress from another server survives.
  let supersededFilesRemoved = false;
  const removeSupersededCacheFiles = Effect.gen(function* () {
    for (const fileName of LEGACY_SCAN_CACHE_FILE_NAMES) {
      yield* fileSystem.remove(path.join(config.stateDir, fileName)).pipe(Effect.ignore);
    }
    const tempPrefixes = [SCAN_CACHE_FILE_NAME, ...LEGACY_SCAN_CACHE_FILE_NAMES].map(
      (fileName) => `${fileName}.`,
    );
    const staleBeforeMs = (yield* Clock.currentTimeMillis) - STALE_TEMP_DIRECTORY_MS;
    for (const name of yield* fileSystem.readDirectory(config.stateDir)) {
      if (!tempPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      const tempPath = path.join(config.stateDir, name);
      yield* fileSystem.stat(tempPath).pipe(
        Effect.flatMap((info) => {
          const mtimeMs = Option.getOrUndefined(info.mtime)?.getTime();
          return info.type === "Directory" && mtimeMs !== undefined && mtimeMs <= staleBeforeMs
            ? fileSystem.remove(tempPath, { recursive: true })
            : Effect.void;
        }),
        Effect.ignore,
      );
    }
  }).pipe(Effect.ignore);

  // Clear dirty before encoding to retain concurrent changes; restore it on failure for retry.
  const persistCaches = Effect.gen(function* () {
    if (cacheDirty) {
      cacheDirty = false;
      yield* Effect.sync(() =>
        writeScanCache(fileCache, {
          sources: Object.fromEntries(sourceCache),
          coveredSince: Object.fromEntries(coveredSince),
        }),
      ).pipe(
        Effect.flatMap((contents) => writeCacheFile(scanCachePath, contents)),
        Effect.andThen(
          Effect.suspend(() => {
            if (supersededFilesRemoved) return Effect.void;
            supersededFilesRemoved = true;
            return removeSupersededCacheFiles;
          }),
        ),
        Effect.catchCause(() =>
          Effect.sync(() => {
            cacheDirty = true;
          }),
        ),
      );
    }
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  // Background writes: saved caches, and closes of Usage's labels.
  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const trackPending = (fiber: Fiber.Fiber<void>) => {
    pendingPersists.add(fiber);
    fiber.addObserver(() => pendingPersists.delete(fiber));
  };
  const schedulePersist = Effect.forkDetach(persistCaches).pipe(Effect.map(trackPending));
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  /**
   * Reads run concurrently, and the caller stores updates in walk order rather
   * than completion order: saved records of deleted transcripts aggregate in
   * cache order, where the first copy of a duplicate decides its bucket. Untraced: a scan
   * reads thousands of files, so scanTranscriptDir records the counts instead.
   */
  const readFileRecords = Effect.fnUntraced(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
  ): Effect.fn.Return<{
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: number;
    readonly failed?: true;
    readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
  }> {
    const cached = fileCache.get(filePath);
    // Provider is part of the identity: if both providers were ever pointed
    // at one directory, a hit parsed by the other parser must not be reused.
    if (
      cached &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.provider === provider
    ) {
      return {
        records:
          cached.tailRecords.length === 0
            ? cached.records
            : [...cached.records, ...cached.tailRecords],
        malformedRecords: cached.malformedRecords,
      };
    }

    // Only a strictly grown file may resume. Same size with a new mtime, or
    // a shrunken file, means rewritten content; re-parse it whole.
    const resumeFrom =
      cached !== undefined && cached.provider === provider && size > cached.size
        ? cached.position
        : undefined;

    const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, format, resumeFrom));
    // A read failure is not an empty transcript: caching it under this
    // (size, mtime) would silently drop the file's usage until it changes.
    if (parsed === null)
      return {
        records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
        malformedRecords: cached?.provider === provider ? cached.malformedRecords : 0,
        failed: true,
      };

    const identity = (record: UsageRecord) =>
      encodeUsageRecordKey([
        record.provider,
        record.sessionId,
        record.timestampMs,
        record.model,
        record.rateModel,
        record.totals,
        record.reportedCostUsd,
        record.dedupeKey,
      ]);
    if (!parsed.resumed && cached !== undefined && cached.provider === provider) {
      // A whole-file re-parse re-emits saved requests unresolved. Keep their saved tier
      // corrections, since the history that resolved them may no longer be available.
      // Equal requests keep their own corrections by matching occurrences in order.
      const saved = new Map<string, UsageRecord[]>();
      for (const previous of [...cached.records, ...cached.tailRecords]) {
        const corrected = correctedRecord(previous);
        const key = identity(corrected);
        const occurrences = saved.get(key);
        if (occurrences === undefined) saved.set(key, [corrected]);
        else occurrences.push(corrected);
      }
      for (const record of [...parsed.records, ...parsed.tailRecords]) {
        const corrected = saved.get(identity(record))?.shift();
        if (
          record.unresolvedServiceTierTurnId !== undefined &&
          corrected !== undefined &&
          corrected.unresolvedServiceTierTurnId === undefined
        ) {
          resolvedRecords.set(record, corrected);
        }
      }
    }
    if (parsed.resumed && cached !== undefined && cached.tailRecords.length > 0) {
      // Completing a tentative line reparses it. Reuse its saved correction only when the
      // same usage is emitted again, without putting inferred tiers in the parser state.
      const reparsed = [...parsed.records, ...parsed.tailRecords];
      for (const [index, previous] of cached.tailRecords.entries()) {
        const record = reparsed[index];
        const corrected = correctedRecord(previous);
        if (
          record?.unresolvedServiceTierTurnId !== undefined &&
          corrected.unresolvedServiceTierTurnId === undefined &&
          identity(record) === identity(corrected)
        ) {
          resolvedRecords.set(record, corrected);
        }
      }
    }
    const base = parsed.resumed && cached !== undefined ? cached.records : [];
    const records = dedupeWithinFile([...base, ...parsed.records]);
    const tailRecords = parsed.tailRecords;

    return {
      records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
      malformedRecords: parsed.malformedRecords,
      update: {
        entry: {
          size,
          mtimeMs,
          provider,
          records,
          tailRecords,
          malformedRecords: parsed.malformedRecords,
          position: parsed.position,
        },
        replaces: cached,
      },
    };
  });

  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly physicalSourceId?: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly files:
      | readonly {
          readonly path: string;
          readonly records: readonly UsageRecord[];
          readonly malformedRecords: number;
        }[]
      | null;
    /** Every transcript path the walk listed, in walk order, whatever its mtime. */
    readonly walked?: readonly string[];
    readonly refreshing?: true;
    /** A provider account's history (the reader names its own volume), not this machine's transcripts. */
    readonly account?: true;
  }

  const archiveFields = (archive: UsageArchiveLabel | undefined) =>
    archive === undefined ? {} : { hostId: archive.host };

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
    fromMemory: boolean,
  ) {
    const { provider, format, dir, volumeId, physicalSourceId, fileName } = source;
    const identity = {
      provider,
      dir,
      volumeId,
      ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
    };
    const label = archiveFields(source.archive);
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) {
      cover(source, windowStartMs);
      return { ...identity, files: null, ...label } satisfies ScannedDir;
    }
    // scanSummary aggregates the saved files, as it does for a deleted directory.
    if (fromMemory) return { ...identity, files: [], ...label } satisfies ScannedDir;
    const { files, walked, failedPaths } = yield* Effect.promise(() =>
      listTranscriptFiles(dir, windowStartMs, fileName === undefined ? undefined : { fileName }),
    );
    const read = yield* Effect.forEach(
      files,
      (file) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider, format).pipe(
          Effect.map((result) => ({ path: file.path, ...result })),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const parsedFiles = read.map(({ path, records, malformedRecords, update }) => {
      if (update === undefined) return { path, records, malformedRecords };
      // A scan of another window may have cached its own read of this file
      // meanwhile. Then keep whichever read saw the later file, so a slower
      // scan never replaces newer usage with older.
      const current = fileCache.get(path);
      if (
        current === update.replaces ||
        current === undefined ||
        isLaterRead(update.entry, current)
      ) {
        fileCache.set(path, {
          ...update.entry,
          records: correctedBatch(update.entry.records),
          tailRecords: correctedBatch(update.entry.tailRecords),
        });
        cacheDirty = true;
      }
      return { path, records, malformedRecords };
    });
    const livePaths = new Set(files.map((file) => file.path));
    for (const file of read) {
      if (file.failed || !file.path.endsWith(".jsonl.zst")) continue;
      const originalPath = file.path.slice(0, -4);
      // A successfully read archive replaces the original's saved records and diagnostics.
      if (!livePaths.has(originalPath) && fileCache.delete(originalPath)) cacheDirty = true;
    }
    const unread = failedPaths + read.filter((file) => file.failed).length;
    if (unread === 0) cover(source, windowStartMs);
    yield* Effect.annotateCurrentSpan({
      "usage.files": files.length,
      "usage.files_parsed": read.filter((file) => file.update !== undefined).length,
    });
    return {
      ...identity,
      files: parsedFiles,
      walked,
      ...label,
      ...(unread > 0
        ? {
            status: "partial",
            message: `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    } satisfies ScannedDir;
  });

  // Archived caches do not change once copied; decode each one once per file version.
  const archivedCacheEntries = new Map<
    string,
    { readonly size: number; readonly mtimeMs: number; readonly cache: ScanCache }
  >();
  const readArchivedCache = Effect.fn("UsageService.readArchivedCache")(function* (
    archived: ArchivedScanCache,
    windowStartMs: number,
  ) {
    const info = yield* fileSystem.stat(archived.file).pipe(Effect.option);
    if (Option.isNone(info)) return [];
    const size = Number(info.value.size);
    const mtimeMs = Option.match(info.value.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
    let entry = archivedCacheEntries.get(archived.file);
    if (entry === undefined || entry.size !== size || entry.mtimeMs !== mtimeMs) {
      const document = yield* fileSystem.readFileString(archived.file).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      entry = {
        size,
        mtimeMs,
        cache: decodeScanCache(upgradeArchivedScanCache(document), transcriptFormats),
      };
      archivedCacheEntries.set(archived.file, entry);
    }
    const dir = path.dirname(archived.file);
    const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
    const byProvider = new Map<
      UsageProviderKind,
      Array<{ path: string; records: UsageRecord[]; malformedRecords: number }>
    >();
    for (const [filePath, file] of entry.cache) {
      if (file.mtimeMs < windowStartMs) continue;
      const files = byProvider.get(file.provider) ?? [];
      files.push({
        path: filePath,
        records: [...file.records, ...file.tailRecords],
        malformedRecords: file.malformedRecords,
      });
      byProvider.set(file.provider, files);
    }
    return [...byProvider].map(([provider, files]): ScannedDir => ({
      provider,
      dir,
      volumeId,
      files,
      ...archiveFields({ host: archived.host, instance: archived.instance }),
    }));
  });

  const addArchivedDirs = Effect.fn("UsageService.addArchivedDirs")(function* (
    { dirs: liveDirs, pending }: Effect.Success<ReturnType<typeof resolveTranscriptDirs>>,
    settings: ServerSettingsValue,
  ) {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const archive = yield* Effect.promise(() =>
      discoverUsageArchive(
        settings.usageArchiveDirs.map((root) => path.resolve(expandHomePath(root, homeDirectory))),
      ),
    );
    // Archived copies come after live directories: the aggregator keeps the
    // first copy of a duplicate, so usage still on disk stays credited live.
    const archivedDirs: TranscriptSource[] = [];
    const seenDirs = new Set(liveDirs.map(({ provider, dir }) => `${provider}\0${dir}`));
    for (const archived of archive.transcripts) {
      const format = transcriptFormats.get(archived.provider);
      if (format === undefined) continue;
      const dir = yield* fileSystem
        .realPath(archived.dir)
        .pipe(Effect.orElseSucceed(() => archived.dir));
      const key = `${archived.provider}\0${dir}`;
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      archivedDirs.push({
        provider: archived.provider,
        format,
        dir,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(dir)),
        ...(archived.fileName === undefined ? {} : { fileName: archived.fileName }),
        archive: { host: archived.host, instance: archived.instance },
      });
    }
    return { dirs: [...liveDirs, ...archivedDirs], pending, archivedCaches: archive.caches };
  });

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    { dirs, pending, archivedCaches }: Effect.Success<ReturnType<typeof addArchivedDirs>>,
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
    fromMemory: boolean,
  ) {
    const scans = Effect.forEach(
      scanReaders,
      ({ driver, reader }) =>
        usageInstances(driver, settings).pipe(
          Effect.flatMap((instances) =>
            reader.scan({ instances, settings, windowStartMs, retentionCutoffMs, awaitRefresh }),
          ),
          Effect.flatMap((sources) =>
            Effect.forEach(sources, ({ volumeId, ...source }) =>
              Effect.map(
                // A reader's own volumeId names a remote account, not a local directory.
                volumeId === undefined
                  ? Effect.all([
                      Effect.promise(() => readDirectoryVolumeId(source.dir)),
                      physicalSourceId(source.dir),
                    ])
                  : Effect.succeed<[string, string | undefined]>([volumeId, undefined]),
                ([resolved, sourceId]): ScannedDir => ({
                  ...source,
                  files: source.files?.map((file) => ({ ...file, malformedRecords: 0 })) ?? null,
                  provider: reader.provider,
                  volumeId: resolved,
                  ...(sourceId === undefined ? {} : { physicalSourceId: sourceId }),
                  ...(volumeId === undefined ? {} : { account: true as const }),
                }),
              ),
            ),
          ),
          Effect.provideContext(readerContext),
        ),
      { concurrency: "unbounded" },
    );

    // Scan independent sources together, directories sequentially to bound open files; keep order, since the first copy decides a duplicate's bucket.
    const [transcripts, scanDirs, archivedScans] = yield* Effect.all(
      [
        Effect.forEach(dirs, (dir) => scanTranscriptDir(dir, windowStartMs, fromMemory)),
        scans,
        Effect.forEach(archivedCaches, (cache) => readArchivedCache(cache, windowStartMs)),
      ],
      { concurrency: "unbounded" },
    );
    const scanned: readonly ScannedDir[] = [
      ...transcripts,
      ...pending,
      ...scanDirs.flat(),
      ...archivedScans.flat(),
    ];
    return scanned;
  });

  const usageWork = makeUsageWork({
    homeDir: yield* HostProcess.HomeDirectory,
    foldersCachePath: path.join(config.stateDir, USAGE_SESSION_FOLDERS_FILE_NAME),
  });
  const activeProjects = sql<{ readonly id: ProjectId; readonly root: string }>`
    SELECT project_id AS id, workspace_root AS root
    FROM projection_projects
    WHERE deleted_at IS NULL
  `;
  const threadWorktrees = sql<WorkWorktree>`
    SELECT DISTINCT
      json_extract(payload_json, '$.worktreePath') AS path,
      project_id AS "projectId"
    FROM orchestration_v2_projection_threads
    WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.worktreePath') END
      IS NOT NULL
  `;
  // Projects' and folders' usage counts to their groups; with neither, every group is empty.
  const placeWork = Effect.fn("UsageService.placeWork")(function* (
    settings: ServerSettingsValue,
    seen: WorkFolders,
  ) {
    const groups = settings.usageWorkGroups;
    const [projects, worktrees] = groupsPlaceWork(groups)
      ? yield* Effect.all([activeProjects, threadWorktrees]).pipe(
          Effect.tapError((error) => Effect.logWarning("Usage could not read projects", error)),
          Effect.orElseSucceed(() => [[], []] as const),
        )
      : [[], []];
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* Effect.promise(() =>
      usageWork.attribution(groups, projects, worktrees, seen, nowMs),
    );
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    provisional: boolean,
    withRecords: boolean,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const windowEndMs =
      hourlyWindow?.untilTimeMs ??
      Date.parse(`${input.untilDay}T00:00:00Z`) + 86400000 + MTIME_SLACK_MS;

    const retentionCutoffMs =
      settings.usageHistoryRetentionDays === "unlimited"
        ? 0
        : Math.max(0, startedAtMs - settings.usageHistoryRetentionDays * 24 * 60 * 60 * 1000);

    const awaitRefresh = input.awaitRefresh === true;
    const collect = Effect.gen(function* () {
      const resolved = yield* resolveTranscriptDirs(settings, retentionCutoffMs, awaitRefresh).pipe(
        Effect.provideContext(readerContext),
        Effect.flatMap((live) => addArchivedDirs(live, settings)),
      );
      // A window no complete scan has read would show partial totals, so every directory must cover it.
      // Saved files are keyed by path, so two providers reading one directory keep only one parse.
      const fromMemory =
        provisional &&
        resolved.dirs.length > 0 &&
        new Set(resolved.dirs.map((source) => source.dir)).size === resolved.dirs.length &&
        resolved.dirs.every(
          (source) => (coveredSince.get(coverageKey(source)) ?? Infinity) <= windowStartMs,
        );
      const [, scanned] = yield* Effect.all(
        [
          fromMemory ? loadSavedRates : provisional ? ensureRates(false) : Effect.void,
          collectDirs(
            resolved,
            windowStartMs,
            settings,
            retentionCutoffMs,
            awaitRefresh,
            fromMemory,
          ),
        ],
        { concurrency: 2 },
      );
      return { scannedDirs: scanned, fromMemory };
    });
    // Usage still loads without origins; the summary then omits them.
    const unlessUnreadable = <A>(effect: Effect.Effect<A, UsageOrigins.UsageOriginsReadError>) =>
      effect.pipe(
        Effect.tapError((error) => Effect.logWarning(error.message, error.cause)),
        Effect.orElseSucceed(() => null),
      );
    // Labels a close wrote down are read as stored; only the open tail is worked out here.
    const closedSpan = yield* unlessUnreadable(usageOrigins.closedSpan);
    const isClosedAt = (atMs: number) => UsageClose.isClosed(closedSpan, atMs);
    const liveSinceMs =
      closedSpan === null || windowStartMs < closedSpan.fromMs
        ? windowStartMs
        : Math.max(windowStartMs, closedSpan.throughMs + 1);
    const [{ scannedDirs, fromMemory }, , liveOrigins] = yield* Effect.all(
      [
        collect,
        provisional ? Effect.void : ensureRates(false),
        liveSinceMs < windowEndMs
          ? unlessUnreadable(usageOrigins.read(liveSinceMs, windowEndMs))
          : Effect.succeed(UsageOrigins.EMPTY_SNAPSHOT),
      ],
      { concurrency: 3 },
    );
    const recordSources = new Map(
      scannedDirs.flatMap((scanned): [string, UsageOrigins.UsageRecordSource][] =>
        scanned.account === true
          ? [[scanned.dir, "account"]]
          : scanned.hostId === undefined
            ? []
            : [[scanned.dir, "archive"]],
      ),
    );

    const priceOverrides = createOverrideRateTable(settings.usagePriceOverrides);
    const modelAliases = resolveModelAliases(settings.usageModelAliases);
    const sources: UsageSource[] = [];

    // Deleted transcripts' saved usage still aggregates and deduplicates normally.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    // Saved paths are files below a scanned root, so their folder decides; folders repeat thousands of times.
    const withinDir = (dir: string) => {
      const foldersWithin = new Map<string, boolean>();
      return (filePath: string) => {
        const folder = path.dirname(filePath);
        let within = foldersWithin.get(folder);
        if (within === undefined) {
          within = isWithinDirectory(folder, dir);
          foldersWithin.set(folder, within);
        }
        return within;
      };
    };
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      const isRetained = withinDir(dir);
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
          livePaths.has(filePath) ||
          !isRetained(filePath)
        )
          continue;
        retainedFiles.push({
          path: filePath,
          records:
            entry.tailRecords.length === 0
              ? entry.records
              : [...entry.records, ...entry.tailRecords],
          malformedRecords: entry.malformedRecords,
        });
      }
      return retainedFiles;
    });
    // Usage two transcripts share counts in the first one, so saved files take the order an exact
    // scan reads them in: walked files in walk order, then the directory's deleted files.
    for (const { provider, dir, walked } of fromMemory ? [] : scannedDirs) {
      if (walked === undefined) continue;
      const within = withinDir(dir);
      const saved = [...fileCache.keys()];
      const members = new Set(
        saved.filter(
          (filePath) => fileCache.get(filePath)!.provider === provider && within(filePath),
        ),
      );
      if (members.size < 2) continue;
      const listed = new Set(walked);
      const target = [
        ...walked.filter((filePath) => members.has(filePath)),
        ...saved.filter((filePath) => members.has(filePath) && !listed.has(filePath)),
      ];
      let next = 0;
      const ordered = saved.map((filePath) => (members.has(filePath) ? target[next++]! : filePath));
      if (ordered.every((filePath, index) => filePath === saved[index])) continue;
      const entries = new Map(fileCache);
      fileCache.clear();
      for (const filePath of ordered) fileCache.set(filePath, entries.get(filePath)!);
      cacheDirty = true;
    }

    // The models priced below, as UsageAggregator resolves them: an alias replaces rateModel.
    const rateModels = new Set<string>();
    // The folders the kind-of-work split places records by, gathered on the same walk.
    const placesWork = groupsPlaceWork(settings.usageWorkGroups);
    const workCwds = new Set<string>();
    const workFiles = new Map<
      string,
      { readonly provider: UsageProviderKind; readonly sourceDir: string }
    >();
    for (const [index, files] of filesByDir.entries()) {
      const sourceDir = scannedDirs[index]!.dir;
      for (const file of files) {
        for (const record of file.records) {
          if (placesWork) {
            if (record.cwd !== undefined) workCwds.add(record.cwd);
            else if (!workFiles.has(file.path)) {
              workFiles.set(file.path, { provider: record.provider, sourceDir });
            }
          }
          const alias = modelAliases.get(record.model);
          const model = alias ?? record.model;
          if (priceOverrides.has(model.trim())) continue;
          rateModels.add(alias === undefined ? (record.rateModel ?? model) : model);
        }
      }
    }
    // A saved answer prices with saved rates and the full scan after it refetches.
    if (!fromMemory) yield* refreshForUnlistedModels(rateModels);
    const work = yield* placeWork(settings, { cwds: workCwds, files: workFiles });

    const closedRecords: UsageRecord[] = [];
    if (liveOrigins !== null && closedSpan !== null) {
      for (const files of filesByDir) {
        for (const file of files) {
          for (const record of file.records) {
            if (
              record.timestampMs >= windowStartMs &&
              record.timestampMs < windowEndMs &&
              isClosedAt(record.timestampMs)
            )
              closedRecords.push(record);
          }
        }
      }
    }
    const overlapsClosed =
      closedSpan !== null &&
      windowStartMs <= closedSpan.throughMs &&
      windowEndMs > closedSpan.fromMs;
    const closed =
      liveOrigins === null || closedSpan === null || !overlapsClosed
        ? null
        : yield* unlessUnreadable(
            usageOrigins.readClosed({
              span: closedSpan,
              sessionIds: [...new Set(closedRecords.map((record) => record.sessionId))],
              sinceMs: windowStartMs,
              untilMs: windowEndMs,
            }),
          );
    // A transcript found after its day closed has no stored label: it is worked out live.
    const orphaned =
      closed !== null &&
      liveSinceMs > windowStartMs &&
      closedRecords.some((record) => closed.labels.labelAt(record) === undefined);
    const orphanOrigins =
      orphaned && closedSpan !== null
        ? yield* unlessUnreadable(
            usageOrigins.read(windowStartMs, Math.min(windowEndMs, closedSpan.throughMs + 1)),
          )
        : liveOrigins;
    const liveIndex = liveOrigins === null ? null : new UsageOrigins.UsageOriginIndex(liveOrigins);
    const orphanIndex =
      orphanOrigins === liveOrigins
        ? liveIndex
        : orphanOrigins === null
          ? null
          : new UsageOrigins.UsageOriginIndex(orphanOrigins);
    const storedLabelOf = (record: UsageRecord) =>
      isClosedAt(record.timestampMs) ? closed?.labels.labelAt(record) : undefined;
    const labelOf =
      liveIndex === null || orphanIndex === null || (closed === null && overlapsClosed)
        ? null
        : (record: UsageRecord) =>
            storedLabelOf(record) ??
            (isClosedAt(record.timestampMs) ? orphanIndex : liveIndex).lookup(record);
    // What a close can write down next: this read's records after the last close.
    const openRecords: UsageOrigins.OriginRecord[] | null =
      labelOf === null || input.modelFilter !== undefined ? null : [];
    const closedThroughMs = closedSpan?.throughMs ?? UsageClose.CLOSE_FROM_MS - 1;

    const summaryPricing = pricing();
    const counted: CountedRecord[] | null = withRecords ? [] : null;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides,
      modelAliases,
      rateModel: (provider, model) => providerRateModels.get(provider)?.(model),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
      ...(counted === null ? {} : { onRecord: (entry: CountedRecord) => counted.push(entry) }),
      // With no project in a group, every bucket is Other and needs no split on the wire.
      ...(placesWork
        ? {
            attributeWork: (record: UsageRecord, filePath: string | undefined) =>
              work.groupOf(record.cwd, filePath),
          }
        : {}),
      ...(labelOf === null
        ? {}
        : {
            attributeOrigin: (record: UsageRecord, sourcePath: string | undefined) => {
              if (openRecords !== null && record.timestampMs > closedThroughMs) {
                const { sessionId, timestampMs, cwd } = record;
                openRecords.push({ sessionId, timestampMs, cwd });
              }
              return UsageOrigins.settleOrigin(
                labelOf(record),
                record.timestampMs,
                (sourcePath === undefined ? undefined : recordSources.get(sourcePath)) ?? "live",
              );
            },
          }),
    });
    const prompts =
      labelOf === null
        ? []
        : [
            ...(liveOrigins?.prompts ?? []).filter((prompt) => !isClosedAt(prompt.createdAtMs)),
            ...(closed?.prompts ?? []),
          ];
    for (const prompt of prompts) {
      aggregator.countPrompt(
        prompt.createdAtMs,
        UsageOrigins.settleOrigin(prompt.key, prompt.createdAtMs, "live"),
      );
    }
    let resolvedAny = false;
    for (const { reader } of transcriptReaders) {
      if (reader.resolveServiceTiers === undefined || fromMemory) continue;
      const pending = new Set<UsageRecord>();
      for (const [index, files] of filesByDir.entries()) {
        if (scannedDirs[index]?.provider !== reader.provider) continue;
        for (const file of files) {
          for (const raw of file.records) {
            const record = correctedRecord(raw);
            if (
              record.provider === reader.provider &&
              record.unresolvedServiceTierTurnId !== undefined &&
              record.timestampMs >= windowStartMs &&
              record.timestampMs < windowEndMs
            ) {
              pending.add(record);
            }
          }
        }
      }
      if (pending.size === 0) continue;
      const resolved = yield* reader
        .resolveServiceTiers([...pending])
        .pipe(Effect.provideContext(readerContext));
      for (const [record, speed] of resolved) {
        const { unresolvedServiceTierTurnId: _turnId, ...rest } = record;
        resolvedRecords.set(record, { ...rest, speed });
        resolvedAny = true;
      }
    }
    if (resolvedAny) {
      for (const [filePath, entry] of fileCache) {
        const records = correctedBatch(entry.records);
        const tailRecords = correctedBatch(entry.tailRecords);
        if (records === entry.records && tailRecords === entry.tailRecords) continue;
        // Update the current entry by identity; a slow resolver cannot restore an older file.
        fileCache.set(filePath, { ...entry, records, tailRecords });
        cacheDirty = true;
      }
    }
    const crossFileSessions = sharedSessions(filesByDir.flat());

    for (const [
      index,
      {
        provider,
        dir,
        volumeId,
        physicalSourceId,
        files,
        status,
        message,
        refreshing,
        hostId: sourceHostId,
      },
    ] of scannedDirs.entries()) {
      let scannedFiles = 0;
      let skippedFiles = 0;
      let malformedRecords = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      let counted = false;

      for (const file of filesByDir[index] ?? []) {
        malformedRecords += file.malformedRecords;
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const eventOccurrences = new Map<string, number>();
        for (const rawRecord of file.records) {
          const record = correctedRecord(rawRecord);
          let usageRecord = record;
          if (
            sharedSessionProviders.has(record.provider) &&
            crossFileSessions.has(record.sessionId)
          ) {
            // Dedupe moved copies but retain repeated equal events within a file, including second-precision timestamps.
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (eventOccurrences.get(key) ?? 0) + 1;
            eventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          if (aggregator.add(usageRecord, dir, file.path)) {
            counted = true;
            if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
          }
        }
      }

      const sourceMessage =
        message ?? (files === null ? "No transcript directory on this environment." : null);
      sources.push({
        fingerprint: {
          hostId: sourceHostId ?? hostId,
          provider,
          resolvedHomePath: dir,
          volumeId,
          ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
        },
        status:
          files === null && scannedFiles === 0
            ? "missing"
            : malformedRecords > 0
              ? status === undefined || status === "ok"
                ? "partial"
                : status
              : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords,
        distinctSessions: sessionIds.size,
        message:
          malformedRecords > 0
            ? [sourceMessage, formatMalformedUsageWarning(malformedRecords)]
                .filter(Boolean)
                .join(" ")
            : sourceMessage,
        // A saved answer misses what changed since its scan, so the client must ask again. An
        // empty source stays unmarked: it would only flash a loading row.
        ...(refreshing || (fromMemory && counted && transcriptFormats.has(provider))
          ? { refreshing: true }
          : {}),
      });
    }

    yield* settingsService
      .withSettingsSnapshot((currentSettings) =>
        Effect.sync(() => {
          if (settings.usageHistoryRetentionDays === currentSettings.usageHistoryRetentionDays) {
            const pruned = pruneScanCache(fileCache, retentionCutoffMs);
            if (pruned > 0) {
              cacheDirty = true;
              // Pruned files are no longer saved, so nothing before the cutoff stays covered.
              for (const [key, since] of coveredSince) {
                if (since < retentionCutoffMs) coveredSince.set(key, retentionCutoffMs);
              }
            }
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to read settings before pruning the usage cache", { cause }),
        ),
      );

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const sharedWork = sharedWorkOf(settings.usageWorkGroups, settings.usageWorkShareOther);

    const summary = {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      ...(aggregated.origins === undefined ? {} : { origins: aggregated.origins }),
      workGroups: work.groups,
      ...(sharedWork.length === 0 ? {} : { sharedWork }),
      sources,
      pricing: summaryPricing,
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    } satisfies UsageSummary;
    const records =
      counted === null
        ? null
        : counted
            .toSorted((a, b) => a.record.timestampMs - b.record.timestampMs)
            .map((entry) =>
              toUsageExportRecord(
                entry,
                entry.origin !== null && storedLabelOf(entry.record) !== undefined,
              ),
            );
    return {
      summary,
      originReasons: aggregated.originReasons ?? null,
      records,
      fromMemory,
      openRecords,
    };
  });

  const readWindow = Effect.fn("UsageService.readWindow")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    provisional: boolean,
    withRecords: boolean,
  ) {
    const scanned = yield* scanSummary(input, settings, provisional, withRecords);
    // With nothing marked refreshing the client would keep a saved answer as final.
    return scanned.fromMemory &&
      !scanned.summary.sources.some((source) => source.refreshing === true)
      ? yield* scanSummary(input, settings, false, withRecords)
      : scanned;
  });

  type WindowRead = Effect.Success<ReturnType<typeof readWindow>>;
  const inflightScans = new Map<string, Deferred.Deferred<WindowRead, UsageReadError>>();

  const scanKey = (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    provisional: boolean,
    withRecords: boolean,
  ): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings,
      input.awaitRefresh === true,
      provisional,
      input.modelFilter ?? null,
      withRecords,
    ]);

  const readShared = Effect.fn("UsageService.readShared")(function* (
    requested: UsageSummaryInput,
    withRecords = false,
  ) {
    const { modelFilter: requestedFilter, ...unfiltered } = requested;
    const modelFilter = canonicalModelFilter(requestedFilter);
    const input = modelFilter === undefined ? unfiltered : { ...unfiltered, modelFilter };
    const settings = yield* readSettings;
    const provisional = input.provisional === true && input.awaitRefresh !== true;
    const key = scanKey(input, settings, provisional, withRecords);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Register and fork atomically so cancellation cannot leave a Deferred without a scan.
        const created = Deferred.makeUnsafe<WindowRead, UsageReadError>();
        inflightScans.set(key, created);
        // Detach so caller departure cannot cancel shared scans; finished scans warm the cache.
        // Register writes before releasing waiters, but start writing after delivering their summary.
        yield* readWindow(input, settings, provisional, withRecords).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(
                Exit.isSuccess(exit) ? Effect.andThen(schedulePersist, scheduleClose) : Effect.void,
              ),
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    return yield* Deferred.await(deferred);
  });

  const utcDay = (ms: number) =>
    UsageDay.make(DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 10));
  /**
   * The records a close after `afterMs` through `throughMs` labels. It reads the UTC days the span
   * covers, so it does not depend on which window a client asked for. Undefined while a source is
   * still refreshing, since it has not given all its records yet.
   */
  const closingRecords = Effect.fn("UsageService.closingRecords")(function* (
    afterMs: number,
    throughMs: number,
  ) {
    const read = yield* readShared({
      timeZone: "UTC",
      sinceDay: utcDay(afterMs + 1),
      untilDay: utcDay(throughMs),
      awaitRefresh: true,
    });
    return read.openRecords === null || read.summary.sources.some((source) => source.refreshing)
      ? undefined
      : read.openRecords;
  });

  /** Writes down every label older than a day once the open tail is longer than two days. */
  const closeDue = Effect.gen(function* () {
    const span = yield* usageOrigins.closedSpan;
    const nowMs = yield* Clock.currentTimeMillis;
    const afterMs = span?.throughMs ?? UsageClose.CLOSE_FROM_MS - 1;
    if (nowMs - afterMs <= UsageClose.CLOSE_DUE_MS) return;
    const throughMs = nowMs - UsageClose.CLOSE_AGE_MS;
    const records = yield* closingRecords(afterMs, throughMs);
    if (records === undefined) return;
    const outcome = yield* usageOrigins.close(throughMs, records);
    if (outcome.closed) yield* Effect.logInfo("Usage closed its labels", outcome);
  });
  const closeLock = yield* Semaphore.make(1);
  const layerScope = yield* Effect.scope;
  // The read that triggers a close returns first; a close already running is not queued again.
  const scheduleClose: Effect.Effect<void> = closeDue.pipe(
    closeLock.withPermitsIfAvailable(1),
    Effect.catchCause((cause) => Effect.logWarning("Usage could not close its labels", cause)),
    Effect.asVoid,
    Effect.withSpan("UsageService.closeDue"),
    Effect.forkIn(layerScope),
    Effect.map(trackPending),
  );

  const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const closeBackupDir = path.join(config.stateDir, "usage-closes");
  const refuse = (reason: UsageClose.UsageCloseError["reason"], detail: string) =>
    new UsageClose.UsageCloseError({ reason, detail });
  // Waits for a daily close already running, and keeps one from starting meanwhile.
  const closeThrough = Effect.fn("UsageService.closeThrough")(
    function* (input: { readonly throughMs: number; readonly dryRun: boolean }) {
      const { throughMs, dryRun } = input;
      const nowMs = yield* Clock.currentTimeMillis;
      if (throughMs > nowMs)
        return yield* refuse("future", `${isoAt(throughMs)} is in the future.`);
      const span = yield* usageOrigins.closedSpan;
      const afterMs = span?.throughMs ?? UsageClose.CLOSE_FROM_MS - 1;
      if (throughMs <= afterMs)
        return yield* refuse(
          "alreadyClosed",
          `labels are already closed through ${isoAt(afterMs)}; a close never moves back.`,
        );
      const records = yield* closingRecords(afterMs, throughMs);
      if (records === undefined)
        return yield* refuse("refreshing", "a usage source is still refreshing; try again.");
      let backupPath: string | null = null;
      if (!dryRun) {
        const takenAt = DateTime.formatIso(yield* DateTime.now);
        backupPath = yield* UsageClose.backupClosedTables({
          dir: closeBackupDir,
          id: `close-${takenAt.replace(/[-:.]/g, "").slice(0, 15)}`,
          takenAt,
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      }
      const outcome = yield* usageOrigins.close(throughMs, records, { dryRun });
      if (outcome.closed) yield* Effect.logInfo("Usage closed its labels on request", outcome);
      if (!outcome.closed && outcome.why !== "dryRun")
        return yield* outcome.why === "differs"
          ? refuse(
              "differs",
              "labels read back differently, so nothing was written (see the server log).",
            )
          : refuse("superseded", "another close moved the closed span meanwhile; try again.");
      return {
        dryRun,
        closedThrough: span === null ? null : isoAt(span.throughMs),
        through: isoAt(throughMs),
        records: outcome.records,
        sessionRows: outcome.sessionRows,
        promptRows: outcome.promptRows,
        born: outcome.born,
        backupPath,
      } satisfies UsageCloseResult;
    },
    closeLock.withPermits(1),
    Effect.mapError((error) =>
      error._tag === "UsageCloseError" ? error : refuse("failed", error.message),
    ),
  );

  const annotationsPath = path.join(config.stateDir, USAGE_ANNOTATIONS_FILE_NAME);
  const readSummary = Effect.fn("UsageService.readSummary")(function* (
    requested: UsageSummaryInput,
  ) {
    const { summary } = yield* readShared(requested);
    const annotations = yield* readUsageAnnotations(annotationsPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    return annotations.length === 0 ? summary : { ...summary, annotations };
  });

  const readOriginReasons = Effect.fn("UsageService.readOriginReasons")(function* (
    window: Pick<UsageSummaryInput, "sinceDay" | "untilDay" | "timeZone">,
  ) {
    const { originReasons } = yield* readShared(window);
    if (originReasons === null) {
      return yield* new UsageReadError({
        reason: "scanFailed",
        detail: "Could not read the origins of T3 prompts.",
      });
    }
    return originReasons;
  });

  const readRecords = Effect.fn("UsageService.readRecords")(function* (
    window: Pick<UsageSummaryInput, "sinceDay" | "untilDay" | "timeZone">,
  ) {
    // Waits for every source, as a close does, so an export never holds part of a day.
    const { records } = yield* readShared({ ...window, awaitRefresh: true }, true);
    return records ?? [];
  });

  return {
    readSummary,
    readOriginReasons,
    readRecords,
    refreshRates,
    closeThrough,
    awaitPersisted,
  } as const;
});

export const layer = Layer.effect(UsageService, make);
