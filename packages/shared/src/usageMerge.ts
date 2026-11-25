import {
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageDeviceBand,
  type UsageProcessBand,
  type UsageSplit,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
  type UsageTokenTotals,
  type UsageWorkMember,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly tokens: UsageTokenTotals;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly unpricedTokens: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

/** When every record lacks rates, costUsd is unknown and must not be displayed as a dollar figure. */
export function isModelCostUnknown(model: ModelTotals): boolean {
  return model.records > 0 && model.unpricedRecords >= model.records;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface HourlyTotals {
  readonly day: string;
  readonly hourStart: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

export interface CategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly unsplit: number;
}

export interface SpeedCost {
  readonly standard: number;
  readonly fast: number;
  readonly ultrafast: number;
  readonly premium: number;
}

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  readonly categoryCost: CategoryCost;
  readonly speedCost: SpeedCost;
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly contractMismatches: readonly UsageContractMismatch[];
  /** Usage by device band (see `MergedDeviceBand`); null when no selected server labels devices. */
  readonly devices: MergedSplit<MergedDeviceBand> | null;
  /** Usage by process; usage no server places in one counts as other. */
  readonly processes: MergedSplit<UsageProcessBand>;
  /** Usage by kind-of-work group; `OTHER_WORK` holds usage in no group. */
  readonly work: MergedSplit<string>;
  /** The servers' group names in their settings order, first server first. */
  readonly workGroups: readonly string[];
  /** Kinds of work's own `#rrggbb` colours by name, first server first. */
  readonly workGroupColors: ReadonlyMap<string, string>;
  /** Kinds of work any server spreads over the other groups; `OTHER_WORK` for Other. */
  readonly sharedWork: readonly string[];
  /**
   * Usage by kind-of-work member under `workMemberKey(group, member)`, before shared usage is
   * spread; see `usageMemberBands`.
   */
  readonly workMembers: MergedSplit<string>;
  /** The members the servers name, first server first. */
  readonly workMemberInfo: readonly UsageWorkMember[];
  /** Usage by token type: tokens by type, cost by its priced category; unsplit cost is `other`. */
  readonly types: MergedSplit<UsageTypeBand>;
}

/** A token type the Usage page splits by; `other` holds cost no category accounts for. */
export type UsageTypeBand = "input" | "cacheRead" | "output" | "cacheWrite" | "other";

export interface SplitAmount {
  readonly costUsd: number;
  readonly totalTokens: number;
}

/** A partition of the merged usage: each period's bands add up to the period's totals. */
export interface MergedSplit<Key extends string> {
  readonly totals: ReadonlyMap<Key, SplitAmount>;
  readonly daily: ReadonlyMap<string, ReadonlyMap<Key, SplitAmount>>;
  readonly hourly: ReadonlyMap<string, ReadonlyMap<Key, SplitAmount>>;
}

/** The kind-of-work key for usage in no group. */
export const OTHER_WORK = "";

/**
 * A device band as clients show it. The computer is the default device: usage with no phone
 * evidence, `unlabelled` history and servers that label no devices included, counts as typed there.
 */
export type MergedDeviceBand = Exclude<UsageDeviceBand, "unlabelled">;
const UNLABELLED_DEVICE: MergedDeviceBand = "computerDirect";
const USAGE_DEVICE_BANDS: readonly MergedDeviceBand[] = [
  "phoneDirect",
  "phoneOrchestrated",
  "computerDirect",
  "computerOrchestrated",
];
const isDeviceBand = (key: string): key is MergedDeviceBand =>
  (USAGE_DEVICE_BANDS as readonly string[]).includes(key);

/** Processes in the order clients list and stack them, top first; other is the catch-all. */
const USAGE_PROCESS_BANDS: readonly UsageProcessBand[] = [
  "journal",
  "routines",
  "incident",
  "other",
];
const isProcessBand = (key: string): key is UsageProcessBand =>
  (USAGE_PROCESS_BANDS as readonly string[]).includes(key);

class SplitAccumulator<Key extends string> {
  readonly totals = new Map<Key, { costUsd: number; totalTokens: number }>();
  readonly daily = new Map<string, Map<Key, { costUsd: number; totalTokens: number }>>();
  readonly hourly = new Map<string, Map<Key, { costUsd: number; totalTokens: number }>>();

  readonly #fallback: Key;
  readonly #keyOf: (key: string) => Key;

  constructor(fallback: Key, keyOf: (key: string) => Key) {
    this.#fallback = fallback;
    this.#keyOf = keyOf;
  }

  /** Usage the split does not name, or an older server's unsplit bucket, counts to the fallback. */
  add(bucket: UsageBucket, split: UsageSplit | undefined, tokens: number): void {
    if (typeof split === "string" || split === undefined) {
      this.#add(
        bucket,
        split === undefined ? this.#fallback : this.#keyOf(split),
        tokens,
        bucket.costUsd,
      );
      return;
    }
    let restTokens = tokens;
    let restCost = bucket.costUsd;
    for (const [key, [partTokens, partCost]] of Object.entries(split)) {
      this.#add(bucket, this.#keyOf(key), partTokens, partCost);
      restTokens -= partTokens;
      restCost -= partCost;
    }
    // The server rounds parts to a micro-dollar; only a real remainder is unsplit usage.
    if (restTokens > 0 || restCost > 1e-4) {
      this.#add(bucket, this.#fallback, Math.max(0, restTokens), Math.max(0, restCost));
    }
  }

  #add(bucket: UsageBucket, key: Key, totalTokens: number, costUsd: number): void {
    addAmount(this.totals, key, totalTokens, costUsd);
    addAmount(mapFor(this.daily, bucket.day), key, totalTokens, costUsd);
    if (bucket.hourStart !== undefined) {
      addAmount(mapFor(this.hourly, bucket.hourStart), key, totalTokens, costUsd);
    }
  }
}

function mapFor<Key>(
  periods: Map<string, Map<Key, { costUsd: number; totalTokens: number }>>,
  period: string,
) {
  let amounts = periods.get(period);
  if (amounts === undefined) {
    amounts = new Map();
    periods.set(period, amounts);
  }
  return amounts;
}

function addAmount<Key>(
  amounts: Map<Key, { costUsd: number; totalTokens: number }>,
  key: Key,
  totalTokens: number,
  costUsd: number,
): void {
  const amount = amounts.get(key);
  if (amount === undefined) amounts.set(key, { costUsd, totalTokens });
  else {
    amount.costUsd += costUsd;
    amount.totalTokens += totalTokens;
  }
}

// volumeId distinguishes machines sharing a hostname and home path.
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

// Sources are one directory when either their legacy key or their physicalSourceId matches.
// physicalSourceId joins a directory read natively by Windows and through a WSL mount (path
// and dev:ino both differ); the legacy key still joins installs whose host scopes differ.
function sourceIdentity(
  environments: readonly EnvironmentUsage[],
): (fingerprint: UsageSourceFingerprint) => string {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const next = parent.get(key);
    if (next === undefined || next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };
  for (const environment of environments) {
    for (const { fingerprint } of environment.summary.sources) {
      if (fingerprint.physicalSourceId === undefined) continue;
      const legacy = find(fingerprintKey(fingerprint));
      const physical = find(`\u0000${fingerprint.provider}\u0000${fingerprint.physicalSourceId}`);
      if (legacy !== physical) parent.set(legacy, physical);
    }
  }
  return (fingerprint) => find(fingerprintKey(fingerprint));
}

function bucketsForSource(summary: UsageSummary, source: UsageSource): readonly UsageBucket[] {
  const providerSources = summary.sources.filter(
    (entry) => entry.fingerprint.provider === source.fingerprint.provider,
  );
  return summary.buckets.filter(
    (bucket) =>
      bucket.provider === source.fingerprint.provider &&
      (bucket.sourcePath === source.fingerprint.resolvedHomePath ||
        (bucket.sourcePath === undefined && providerSources.length === 1)),
  );
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

function claimSources(
  environments: readonly EnvironmentUsage[],
  sourceKey: (fingerprint: UsageSourceFingerprint) => string,
): {
  readonly ownerScanByFingerprint: ReadonlyMap<string, { readonly source: UsageSource }>;
  readonly supplementalBucketsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlySet<UsageBucket>>;
  readonly sessionsByFingerprint: ReadonlyMap<string, number>;
  readonly duplicates: readonly string[];
} {
  const ownerScanByFingerprint = new Map<
    string,
    { environment: EnvironmentUsage; source: UsageSource }
  >();
  const seenBucketKeysByFingerprint = new Map<string, Set<string>>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, Set<UsageBucket>>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort(
    (a, b) =>
      (Date.parse(b.summary.readAt) || 0) - (Date.parse(a.summary.readAt) || 0) ||
      a.environmentId.localeCompare(b.environmentId),
  );

  for (const status of ["ok", "partial", "failed"] as const) {
    for (const environment of ordered) {
      for (const source of environment.summary.sources) {
        if (source.status !== status) continue;
        const key = sourceKey(source.fingerprint);
        if (ownerScanByFingerprint.has(key)) {
          duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
          continue;
        }
        ownerScanByFingerprint.set(key, { environment, source });
        sessionsByFingerprint.set(key, source.distinctSessions);
      }
    }
  }

  // Keep cells unique to newer partial scans; aggregates cannot reconcile overlapping records without double-counting.
  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status !== "partial") continue;
      const key = sourceKey(source.fingerprint);
      const owner = ownerScanByFingerprint.get(key);
      // A scan under another model filter counts different records, so its cells are not missing ones.
      if (
        owner?.source.status !== "ok" ||
        Date.parse(environment.summary.readAt) <= Date.parse(owner.environment.summary.readAt) ||
        JSON.stringify(environment.summary.modelFilter) !==
          JSON.stringify(owner.environment.summary.modelFilter)
      ) {
        continue;
      }
      let seen = seenBucketKeysByFingerprint.get(key);
      if (seen === undefined) {
        seen = new Set(bucketsForSource(owner.environment.summary, owner.source).map(bucketKey));
        seenBucketKeysByFingerprint.set(key, seen);
      }
      const supplemental =
        supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set<UsageBucket>();
      let added = false;
      for (const bucket of bucketsForSource(environment.summary, source)) {
        const cell = bucketKey(bucket);
        if (seen.has(cell)) continue;
        seen.add(cell);
        supplemental.add(bucket);
        added = true;
      }
      if (!added) continue;
      supplementalBucketsByEnvironment.set(environment.environmentId, supplemental);
      sessionsByFingerprint.set(
        key,
        Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions),
      );
    }
  }

  return {
    ownerScanByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  };
}

function ownedContribution(
  environment: EnvironmentUsage,
  ownerScanByFingerprint: ReadonlyMap<string, { readonly source: UsageSource }>,
  supplementalBuckets: ReadonlySet<UsageBucket>,
  sessionsByFingerprint: ReadonlyMap<string, number>,
  sourceKey: (fingerprint: UsageSourceFingerprint) => string,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSources = new Set<string>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = sourceKey(source.fingerprint);
    // By source, not environment: one server can reach a directory through two
    // mounts, and only the winning reading may count.
    if (ownerScanByFingerprint.get(key)?.source === source) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSources.add(`${provider}\u0000${source.fingerprint.resolvedHomePath}`);
      // Count distinct sessions per directory; bucket sums overcount sessions spanning days/models.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsByFingerprint.get(key) ?? source.distinctSessions),
      );
    }
  }
  const owned = (bucket: UsageBucket) =>
    bucket.sourcePath === undefined
      ? ownedProviders.has(bucket.provider)
      : ownedSources.has(`${bucket.provider}\u0000${bucket.sourcePath}`);
  return {
    buckets: environment.summary.buckets.filter(
      (bucket) => supplementalBuckets.has(bucket) || owned(bucket),
    ),
    sessionsByProvider,
  };
}

function bucketTokens(bucket: { readonly totals: UsageTokenTotals }): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
  speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
  duplicateSources: [],
  contributingEnvironments: [],
  contractMismatches: [],
  devices: null,
  processes: { totals: new Map(), daily: new Map(), hourly: new Map() },
  work: { totals: new Map(), daily: new Map(), hourly: new Map() },
  workGroups: [],
  workGroupColors: new Map(),
  sharedWork: [],
  workMembers: { totals: new Map(), daily: new Map(), hourly: new Map() },
  workMemberInfo: [],
  types: { totals: new Map(), daily: new Map(), hourly: new Map() },
};

export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const sourceKey = sourceIdentity(current);
  const {
    ownerScanByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  } = claimSources(current, sourceKey);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const speedCost = { fast: 0, ultrafast: 0, premium: 0 };

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      tokens: UsageTokenTotals;
      records: number;
      unpricedRecords: number;
      unpricedTokens: number;
    }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const hourlyAccumulator = new Map<
    string,
    {
      day: string;
      hourStart: string;
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const contributingEnvironments: EnvironmentId[] = [];
  const devices = new SplitAccumulator<MergedDeviceBand>(UNLABELLED_DEVICE, (key) =>
    isDeviceBand(key) ? key : UNLABELLED_DEVICE,
  );
  const processes = new SplitAccumulator<UsageProcessBand>("other", (key) =>
    isProcessBand(key) ? key : "other",
  );
  const work = new SplitAccumulator<string>(OTHER_WORK, (key) => key);
  // A member split covers only part of a bucket; the rest lands on "" and is never read.
  const workMembers = new SplitAccumulator<string>("", (key) => key);
  const types = new SplitAccumulator<UsageTypeBand>("other", (key) => key as UsageTypeBand);

  for (const environment of current) {
    const groupOfMember = new Map(
      (environment.summary.workMembers ?? []).map((member) => [member.key, member.group]),
    );
    const { buckets, sessionsByProvider } = ownedContribution(
      environment,
      ownerScanByFingerprint,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set(),
      sessionsByFingerprint,
      sourceKey,
    );
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);

    for (const [providerKind, providerSessions] of sessionsByProvider) {
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      const provider = providerAccumulator.get(providerKind) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.sessions += providerSessions;
      providerAccumulator.set(providerKind, provider);
    }

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);
      devices.add(bucket, bucket.devices, tokens);
      processes.add(bucket, bucket.processes, tokens);
      work.add(bucket, bucket.work, tokens);
      if (bucket.workMembers !== undefined && typeof bucket.workMembers !== "string") {
        workMembers.add(
          bucket,
          Object.fromEntries(
            Object.entries(bucket.workMembers).flatMap(([key, amount]) => {
              const group = groupOfMember.get(key);
              return group === undefined ? [] : [[workMemberKey(group, key), amount]];
            }),
          ),
          tokens,
        );
      }
      const category = bucket.categoryCostUsd;
      types.add(
        bucket,
        {
          input: [bucket.totals.uncachedInputTokens, category?.input ?? 0],
          cacheRead: [bucket.totals.cachedInputTokens, category?.cacheRead ?? 0],
          output: [bucket.totals.outputTokens, category?.output ?? 0],
          cacheWrite: [bucket.totals.cacheCreationTokens, category?.cacheWrite ?? 0],
        },
        tokens,
      );

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;
      if (bucket.categoryCostUsd !== undefined) {
        categoryCost.input += bucket.categoryCostUsd.input;
        categoryCost.cacheRead += bucket.categoryCostUsd.cacheRead;
        categoryCost.cacheWrite += bucket.categoryCostUsd.cacheWrite;
        categoryCost.output += bucket.categoryCostUsd.output;
      }
      speedCost.fast += bucket.fastCostUsd ?? 0;
      speedCost.ultrafast += bucket.ultrafastCostUsd ?? 0;
      speedCost.premium += bucket.speedPremiumUsd ?? 0;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        records: 0,
        unpricedRecords: 0,
        unpricedTokens: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.tokens = {
        uncachedInputTokens: model.tokens.uncachedInputTokens + bucket.totals.uncachedInputTokens,
        cachedInputTokens: model.tokens.cachedInputTokens + bucket.totals.cachedInputTokens,
        cacheCreationTokens: model.tokens.cacheCreationTokens + bucket.totals.cacheCreationTokens,
        outputTokens: model.tokens.outputTokens + bucket.totals.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens + bucket.totals.reasoningTokens,
      };
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      if (bucket.unpricedTokens !== undefined) {
        model.unpricedTokens += bucket.unpricedTokens;
      } else if (bucket.records > 0) {
        model.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
      }
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          costUsd: 0,
          totalTokens: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
        };
        hour.costUsd += bucket.costUsd;
        hour.totalTokens += tokens;
        const hourProvider = hour.byProvider.get(bucket.provider) ?? {
          costUsd: 0,
          totalTokens: 0,
        };
        hourProvider.costUsd += bucket.costUsd;
        hourProvider.totalTokens += tokens;
        hour.byProvider.set(bucket.provider, hourProvider);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      tokens: totals.tokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      unpricedTokens: totals.unpricedTokens,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hourly: HourlyTotals[] = [...hourlyAccumulator.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );
  const memberInfo = new Map<string, UsageWorkMember>();
  for (const member of current.flatMap((environment) => environment.summary.workMembers ?? [])) {
    const key = workMemberKey(member.group, member.key);
    if (!memberInfo.has(key)) memberInfo.set(key, member);
  }
  const workMemberInfo = [...memberInfo.values()];
  const workGroupColors = new Map<string, string>();
  for (const environment of current) {
    for (const [group, color] of Object.entries(environment.summary.workGroupColors ?? {})) {
      if (!workGroupColors.has(group)) workGroupColors.set(group, color);
    }
  }

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    categoryCost: {
      ...categoryCost,
      unsplit: Math.max(
        0,
        costUsd -
          categoryCost.input -
          categoryCost.cacheRead -
          categoryCost.cacheWrite -
          categoryCost.output,
      ),
    },
    speedCost: {
      ...speedCost,
      standard: Math.max(0, costUsd - speedCost.fast - speedCost.ultrafast),
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    contractMismatches,
    devices: current.some((environment) => environment.summary.devices === true) ? devices : null,
    processes,
    work,
    workGroups: [
      ...new Set(current.flatMap((environment) => environment.summary.workGroups ?? [])),
    ],
    workGroupColors,
    sharedWork: [
      ...new Set(current.flatMap((environment) => environment.summary.sharedWork ?? [])),
    ],
    workMembers,
    workMemberInfo,
    types,
  };
}

/** One band of a device or kind-of-work split, with what clients need to label and colour it. */
export interface UsageSplitBand extends SplitAmount {
  readonly key: string;
  /** A group's place in the servers' group order, for its colour; null for devices and Other. */
  readonly groupIndex: number | null;
  /** A group's own colour, as `#rrggbb`; without one it takes the palette's by `groupIndex`. */
  readonly color?: string | undefined;
}

export interface UsageSplitBands {
  /** Bands with usage, largest first by the metric; Other always last. */
  readonly bands: readonly UsageSplitBand[];
  /** Shared kinds of work whose usage the bands carry; `OTHER_WORK` for Other. */
  readonly spread: readonly string[];
  /** A band's tokens or cost in one day (or hour, for an hourly split). */
  readonly valueAt: (period: string, key: string, metric: "cost" | "tokens") => number;
}

const NO_AMOUNT: SplitAmount = { costUsd: 0, totalTokens: 0 };

/** A server that labels no devices has all of its usage on the computer. */
function deviceSplitOf(usage: MergedUsage): MergedSplit<MergedDeviceBand> {
  if (usage.devices !== null) return usage.devices;
  const whole = (period: SplitAmount) =>
    new Map([[UNLABELLED_DEVICE, { costUsd: period.costUsd, totalTokens: period.totalTokens }]]);
  return {
    totals: whole(usage),
    daily: new Map(usage.daily.map((day) => [day.day, whole(day)])),
    hourly: new Map(usage.hourly.map((hour) => [hour.hourStart, whole(hour)])),
  };
}

const USAGE_TYPE_BANDS: readonly UsageTypeBand[] = [
  "input",
  "cacheRead",
  "output",
  "cacheWrite",
  "other",
];

/** The kind-of-work split with shared usage spread over the other groups, as the page shows it. */
function spreadWork(usage: MergedUsage, hourly: boolean) {
  const periods = hourly ? usage.work.hourly : usage.work.daily;
  return usage.sharedWork.length > 0
    ? spreadSharedWork(periods, new Set(usage.sharedWork))
    : { periods, totals: usage.work.totals, spread: [] as readonly string[] };
}

export function usageSplitBands(
  usage: MergedUsage,
  split: "device" | "process" | "work" | "type",
  metric: "cost" | "tokens",
  hourly: boolean,
): UsageSplitBands {
  const merged: MergedSplit<string> =
    split === "device"
      ? deviceSplitOf(usage)
      : split === "process"
        ? usage.processes
        : split === "type"
          ? usage.types
          : usage.work;
  const spread = split === "work" ? spreadWork(usage, hourly) : null;
  const periods = spread?.periods ?? (hourly ? merged.hourly : merged.daily);
  const totals = spread?.totals ?? merged.totals;
  const catchAll =
    split === "device" ? null : split === "type" || split === "process" ? "other" : OTHER_WORK;
  const keys =
    split === "device"
      ? USAGE_DEVICE_BANDS
      : split === "process"
        ? USAGE_PROCESS_BANDS
        : split === "type"
          ? USAGE_TYPE_BANDS
          : [
              ...usage.workGroups,
              // Groups only another server names, then the usage in no group.
              ...[...merged.totals.keys()].filter(
                (key) => key !== OTHER_WORK && !usage.workGroups.includes(key),
              ),
              OTHER_WORK,
            ];
  const value = (amount: SplitAmount) => (metric === "cost" ? amount.costUsd : amount.totalTokens);
  const bands = keys
    .map((key, index) => {
      const color = split === "work" ? usage.workGroupColors.get(key) : undefined;
      return {
        key,
        groupIndex: split === "work" && key !== OTHER_WORK ? index : null,
        ...(color === undefined ? {} : { color }),
        ...(totals.get(key) ?? NO_AMOUNT),
      };
    })
    .filter((band) => band.totalTokens > 0 || band.costUsd > 0)
    // Copied first: Hermes lacks toSorted.
    .slice()
    .sort(
      (a, b) =>
        Number(a.key === catchAll) - Number(b.key === catchAll) ||
        value(b) - value(a) ||
        b.totalTokens - a.totalTokens,
    );
  return {
    bands,
    spread: spread?.spread ?? [],
    valueAt: (period, key, by) => {
      const amount = periods.get(period)?.get(key) ?? NO_AMOUNT;
      return by === "cost" ? amount.costUsd : amount.totalTokens;
    },
  };
}

/** A member of a kind of work, with its usage once shared usage is spread. */
export interface UsageMemberBand extends SplitAmount {
  readonly key: string;
  readonly group: string;
  readonly name: string;
  /** Counts to its group and keeps its colour, but gets no row of its own. */
  readonly hidden?: true | undefined;
  /** Its own colour, as `#rrggbb`; without one it takes the group's palette. */
  readonly color?: string | undefined;
}

export interface UsageMemberBands {
  /** The group's members with usage, largest first by the metric. */
  readonly members: readonly UsageMemberBand[];
  readonly valueAt: (period: string, key: string, metric: "cost" | "tokens") => number;
}

/** The first colour among the members one row stands for. */
const pickColor = (same: readonly UsageWorkMember[]) => {
  const color = same.find((member) => member.color !== undefined)?.color;
  return color === undefined ? {} : { color };
};

/** Where `MergedUsage.workMembers` keeps a member's usage in one group. */
const workMemberKey = (group: string, member: string) => `${group}\u0000${member}`;

/**
 * A kind of work's members, scaled per period to add up to the group as shown, shared usage
 * included; a period with only shared usage splits by the members' window shares. Tokens and cost
 * scale by their own measure. Members of one name are one row under the first one's key.
 */
export function usageMemberBands(
  usage: MergedUsage,
  group: string,
  metric: "cost" | "tokens",
  hourly: boolean,
): UsageMemberBands {
  const named = new Map<string, UsageWorkMember[]>();
  for (const member of usage.workMemberInfo) {
    if (member.group !== group) continue;
    const same = named.get(member.name);
    if (same === undefined) named.set(member.name, [member]);
    else same.push(member);
  }
  const rowOf = new Map(
    [...named.values()].flatMap((same) =>
      same.map((member) => [workMemberKey(group, member.key), same[0]!.key] as const),
    ),
  );
  const keys = new Set(rowOf.keys());
  const groupPeriods = spreadWork(usage, hourly).periods;
  const memberPeriods = hourly ? usage.workMembers.hourly : usage.workMembers.daily;
  const window = new Map<string, { costUsd: number; totalTokens: number }>();
  for (const amounts of memberPeriods.values()) {
    for (const [key, amount] of amounts) {
      if (keys.has(key)) addAmount(window, key, amount.totalTokens, amount.costUsd);
    }
  }
  const out = new Map<string, Map<string, { costUsd: number; totalTokens: number }>>();
  const totals = new Map<string, { costUsd: number; totalTokens: number }>();
  for (const [period, amounts] of groupPeriods) {
    const target = amounts.get(group);
    if (target === undefined) continue;
    const own = [...(memberPeriods.get(period) ?? new Map<string, SplitAmount>())].filter(([key]) =>
      keys.has(key),
    );
    const next = new Map<string, { costUsd: number; totalTokens: number }>();
    for (const measure of ["totalTokens", "costUsd"] as const) {
      const weights = sumOf(own, measure) > 0 ? own : [...window];
      const sum = sumOf(weights, measure);
      if (sum === 0) continue;
      for (const [key, weight] of weights) {
        addMeasure(next, rowOf.get(key)!, measure, (target[measure] * weight[measure]) / sum);
      }
    }
    for (const [key, amount] of next) addAmount(totals, key, amount.totalTokens, amount.costUsd);
    out.set(period, next);
  }
  const value = (amount: SplitAmount) => (metric === "cost" ? amount.costUsd : amount.totalTokens);
  const members = [...named.values()]
    .map(([first, ...rest]) => ({
      key: first!.key,
      group,
      name: first!.name,
      // A row is hidden only when every member under it is.
      ...([first!, ...rest].every((member) => member.hidden === true)
        ? { hidden: true as const }
        : {}),
      ...pickColor([first!, ...rest]),
      ...(totals.get(first!.key) ?? NO_AMOUNT),
    }))
    .filter((member) => member.totalTokens > 0 || member.costUsd > 0)
    .slice()
    .sort((a, b) => value(b) - value(a) || b.totalTokens - a.totalTokens);
  return {
    members,
    valueAt: (period, key, by) => {
      const amount = out.get(period)?.get(key) ?? NO_AMOUNT;
      return by === "cost" ? amount.costUsd : amount.totalTokens;
    },
  };
}

type Periods = ReadonlyMap<string, ReadonlyMap<string, SplitAmount>>;

/**
 * Spreads each period's shared usage over the groups that are not shared, in proportion to their
 * usage in that period, else in the whole window; with no such usage anywhere it stays Other.
 * Tokens and cost spread each by their own measure, so every period still adds up.
 */
function spreadSharedWork(
  periods: Periods,
  shared: ReadonlySet<string>,
): {
  readonly periods: Periods;
  readonly totals: ReadonlyMap<string, SplitAmount>;
  readonly spread: readonly string[];
} {
  const receives = (key: string) => key !== OTHER_WORK && !shared.has(key);
  const window = new Map<string, { costUsd: number; totalTokens: number }>();
  const sharedUsage = new Set<string>();
  for (const amounts of periods.values()) {
    for (const [key, amount] of amounts) {
      if (receives(key)) addAmount(window, key, amount.totalTokens, amount.costUsd);
      else if (shared.has(key) && (amount.totalTokens > 0 || amount.costUsd > 0)) {
        sharedUsage.add(key);
      }
    }
  }

  const out = new Map<string, Map<string, { costUsd: number; totalTokens: number }>>();
  const totals = new Map<string, { costUsd: number; totalTokens: number }>();
  for (const [period, amounts] of periods) {
    const next = new Map<string, { costUsd: number; totalTokens: number }>();
    let sharedTokens = 0;
    let sharedCost = 0;
    for (const [key, amount] of amounts) {
      if (shared.has(key)) {
        sharedTokens += amount.totalTokens;
        sharedCost += amount.costUsd;
      } else addAmount(next, key, amount.totalTokens, amount.costUsd);
    }
    for (const measure of ["totalTokens", "costUsd"] as const) {
      const amount = measure === "totalTokens" ? sharedTokens : sharedCost;
      if (amount === 0) continue;
      const own = [...amounts].filter(([key]) => receives(key));
      const weights = sumOf(own, measure) > 0 ? own : [...window];
      const sum = sumOf(weights, measure);
      if (sum === 0) {
        addMeasure(next, OTHER_WORK, measure, amount);
        continue;
      }
      for (const [key, weight] of weights) {
        addMeasure(next, key, measure, (amount * weight[measure]) / sum);
      }
    }
    for (const [key, amount] of next) addAmount(totals, key, amount.totalTokens, amount.costUsd);
    out.set(period, next);
  }
  const received = [...window.values()].some(
    (amount) => amount.totalTokens > 0 || amount.costUsd > 0,
  );
  const spread = received ? [...shared].filter((key) => sharedUsage.has(key)) : [];
  return { periods: out, totals, spread };
}

const sumOf = (amounts: readonly (readonly [string, SplitAmount])[], measure: keyof SplitAmount) =>
  amounts.reduce((sum, [, amount]) => sum + amount[measure], 0);

function addMeasure(
  amounts: Map<string, { costUsd: number; totalTokens: number }>,
  key: string,
  measure: keyof SplitAmount,
  value: number,
): void {
  addAmount(amounts, key, measure === "totalTokens" ? value : 0, measure === "costUsd" ? value : 0);
}
