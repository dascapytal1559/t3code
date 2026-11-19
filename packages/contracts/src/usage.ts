import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Bump for incompatible UsageSummary changes; skipped unknown array variants need no bump. */
export const USAGE_CONTRACT_VERSION = 6 as const;

export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/** Sum uncached input, cache reads, and cache writes for input totals; reasoning is already included in output. */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCategoryCost = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type UsageCategoryCost = typeof UsageCategoryCost.Type;

/** Tokens and cost of part of a bucket. */
export const UsageSplitAmount = Schema.Tuple([NonNegativeInt, Schema.Number]);
export type UsageSplitAmount = typeof UsageSplitAmount.Type;

/** A bucket split by key: the one key holding all of it, or each key's part. */
export const UsageSplit = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, UsageSplitAmount),
]);
export type UsageSplit = typeof UsageSplit.Type;

/**
 * The device band of usage: the device the starting prompt came from, and whether a person typed
 * it there (`Direct`) or an agent sent it on their behalf (`Orchestrated`). `unlabelled` usage
 * predates origins (`USAGE_ORIGINS_RECORDED_SINCE`) or comes from archived history.
 */
export const UsageDeviceBand = Schema.Literals([
  "phoneDirect",
  "phoneOrchestrated",
  "computerDirect",
  "computerOrchestrated",
  "unlabelled",
]);
export type UsageDeviceBand = typeof UsageDeviceBand.Type;

export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  categoryCostUsd: Schema.optional(UsageCategoryCost),
  fastCostUsd: Schema.optional(Schema.Number),
  ultrafastCostUsd: Schema.optional(Schema.Number),
  speedPremiumUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Absent from older servers; merges then estimate it from the unpriced record share. */
  unpricedTokens: Schema.optional(NonNegativeInt),
  sessions: NonNegativeInt,
  /**
   * The bucket by `UsageDeviceBand`; absent when the server cannot read its T3 prompts. Usage in
   * no band, or in a band a client does not know, counts as unlabelled.
   */
  devices: Schema.optional(UsageSplit),
  /** The bucket by `usageWorkGroups` name, `""` for usage in no group (Other). */
  work: Schema.optional(UsageSplit),
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * Where the T3 prompt that started a run came from. An agent's prompt whose recorded cause
 * chain reaches a phone or computer prompt counts there. `crew` is agent-sent work in a
 * FirstMate crew thread with no such chain. Settled usage is only phone or computer; older
 * servers also send agent, crew and unknown rows, which count to the computer.
 */
export const UsageOrigin = Schema.Literals(["phone", "computer", "agent", "crew", "unknown"]);
export type UsageOrigin = typeof UsageOrigin.Type;

/**
 * How the origin was read: the `stamp`, creation fields (`nativeApp`, `sender`, `notification`,
 * `server`, `unstamped`, `noPrompt`), an agent's `claim`, or `terminal` (a session started with no
 * thread or task behind it). Usage with no device evidence counts to the computer as `default`,
 * `beforeOrigins` or `archive`. Older clients drop unknown bases.
 */
export const UsageOriginBasis = Schema.Literals([
  "stamp",
  "nativeApp",
  "sender",
  "notification",
  "server",
  "unstamped",
  "noPrompt",
  "claim",
  "terminal",
  "default",
  "beforeOrigins",
  "archive",
]);
export type UsageOriginBasis = typeof UsageOriginBasis.Type;

/** When this server began recording which device sent each prompt; nothing earlier can trace. */
export const USAGE_ORIGINS_RECORDED_SINCE = "2026-11-07T10:41:00.000Z";

/**
 * Who sent a prompt counted to a phone or computer through its recorded `causedBy` chain:
 * an agent, or an agent in a FirstMate crew thread. Absent when the origin's device sent it.
 */
export const UsageOriginVia = Schema.Literals(["agent", "crew"]);
export type UsageOriginVia = typeof UsageOriginVia.Type;

/**
 * Why usage counts where it does. Device evidence: `typed`, `inherited` (its recorded causes reach
 * a typed prompt), `journal` and `upkeep` (a claim named the phone or computer), `terminal`. Every
 * other reason names what is missing, and that usage counts to the computer by default.
 */
export const UsageOriginReason = Schema.Literals([
  "typed",
  "inherited",
  "journal",
  "upkeep",
  "terminal",
  "unregisteredSession",
  "unmatchedRegistration",
  "lateRecord",
  "unnamedTurn",
  "noCause",
  "untracedCause",
  "noPrompt",
  "unknownDevice",
  "serverPrompt",
  "unstamped",
  "beforeStamps",
  "archive",
  "accountOnly",
]);
export type UsageOriginReason = typeof UsageOriginReason.Type;

const DEVICE_EVIDENCE: ReadonlySet<UsageOriginReason> = new Set([
  "typed",
  "inherited",
  "journal",
  "upkeep",
  "terminal",
]);

/** Usage with this reason has no device evidence and counts to the computer only by default. */
export const usageOriginCountsByDefault = (reason: UsageOriginReason): boolean =>
  !DEVICE_EVIDENCE.has(reason);

/** The kind of usage claim that decided where usage counts. */
export const UsageOriginClaimKind = Schema.Literals(["run", "session", "directory"]);
export type UsageOriginClaimKind = typeof UsageOriginClaimKind.Type;

/** Usage of one provider by why it counts where it does; the rows partition the period's usage. */
export const UsageOriginReasonUsage = Schema.Struct({
  origin: UsageOrigin,
  reason: UsageOriginReason,
  claim: Schema.optional(UsageOriginClaimKind),
  /** Matched to a T3 turn by the folder the session ran in. */
  folder: Schema.optional(Schema.Literal(true)),
  /** Matched by the session's own registration at start. */
  registered: Schema.optional(Schema.Literal(true)),
  /** Decided by a recorded cause (a thread's, message's or claim's `causedBy`), not a value. */
  cause: Schema.optional(Schema.Literal(true)),
  /** No device evidence: the usage counts to the computer only by default. */
  byDefault: Schema.Boolean,
  provider: UsageProviderKind,
  tokens: NonNegativeInt,
  costUsd: Schema.Number,
  records: NonNegativeInt,
});
export type UsageOriginReasonUsage = typeof UsageOriginReasonUsage.Type;

/** Usage by reason over a window of days, largest first, as `t3_usage_reasons` reports it. */
export const UsageOriginReasons = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  timeZone: Schema.String,
  tokens: Schema.Number,
  byDefaultTokens: Schema.Number,
  rows: Schema.Array(UsageOriginReasonUsage),
});
export type UsageOriginReasons = typeof UsageOriginReasons.Type;

/** Streams `UsageExportRecord` JSON lines for `since`, `until` and `timeZone` query parameters. */
export const USAGE_EXPORT_PATH = "/api/usage/export";

/** POST with `through` (epoch ms) and `dryRun=1` to close Usage's labels now; answers `UsageCloseResult`. */
export const USAGE_CLOSE_PATH = "/api/usage/close";

/** What a close through a chosen time wrote down, or would: everything after `closedThrough`. */
export const UsageCloseResult = Schema.Struct({
  dryRun: Schema.Boolean,
  /** Where the closed span ended before; null before the first close. */
  closedThrough: Schema.NullOr(Schema.String),
  through: Schema.String,
  records: NonNegativeInt,
  sessionRows: NonNegativeInt,
  promptRows: NonNegativeInt,
  /** How the labels written at birth compare with these; null before they were written. */
  born: Schema.NullOr(
    Schema.Struct({
      records: NonNegativeInt,
      differingRecords: NonNegativeInt,
      prompts: NonNegativeInt,
      differingPrompts: NonNegativeInt,
      byReason: Schema.Record(Schema.String, Schema.Number),
    }),
  ),
  /** The closed tables as they stood before the close; null for a dry run. */
  backupPath: Schema.NullOr(Schema.String),
});
export type UsageCloseResult = typeof UsageCloseResult.Type;

/** One model call as Usage counted it: deduplicated, aliased, priced and labelled. */
export const UsageExportRecord = Schema.Struct({
  at: Schema.String,
  provider: UsageProviderKind,
  model: Schema.String,
  /** The provider's own session id. */
  sessionId: Schema.String,
  /** The same for a model call in every export, whichever transcript copy was read; null when the provider names none. */
  callId: Schema.NullOr(Schema.String),
  tokens: Schema.Struct({
    input: NonNegativeInt,
    cacheRead: NonNegativeInt,
    cacheWrite: NonNegativeInt,
    output: NonNegativeInt,
  }),
  /** Null when no price is known for the model. */
  costUsd: Schema.NullOr(Schema.Number),
  /** Null when the server could not read its T3 prompts. */
  origin: Schema.NullOr(
    Schema.Struct({
      device: UsageOrigin,
      started: Schema.Literals(["direct", "orchestrated"]),
      via: Schema.optional(UsageOriginVia),
      basis: UsageOriginBasis,
      reason: UsageOriginReason,
      claim: Schema.optional(UsageOriginClaimKind),
      folder: Schema.optional(Schema.Literal(true)),
      registered: Schema.optional(Schema.Literal(true)),
      cause: Schema.optional(Schema.Literal(true)),
      /** The thread of the typed prompt that decided it. */
      promptThreadId: Schema.optional(Schema.String),
    }),
  ),
  /** Its label is read from a written-down row; until then a later export may relabel it. */
  final: Schema.Boolean,
  /** The kind-of-work group of the project it ran in; null when it has none. */
  group: Schema.NullOr(Schema.String),
});
export type UsageExportRecord = typeof UsageExportRecord.Type;

/** Usage of records inside a T3 run, by the origin of the run's starting message. */
export const UsageOriginUsage = Schema.Struct({
  origin: UsageOrigin,
  basis: UsageOriginBasis,
  via: Schema.optional(UsageOriginVia),
  provider: UsageProviderKind,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
});
export type UsageOriginUsage = typeof UsageOriginUsage.Type;

export const UsageOriginPrompts = Schema.Struct({
  origin: UsageOrigin,
  basis: UsageOriginBasis,
  via: Schema.optional(UsageOriginVia),
  prompts: NonNegativeInt,
});
export type UsageOriginPrompts = typeof UsageOriginPrompts.Type;

/** Every usage record settles into a row; servers that predate settling leave records outside T3 runs without one. */
export const UsageOrigins = Schema.Struct({
  usage: ForwardCompatibleArray(UsageOriginUsage),
  prompts: ForwardCompatibleArray(UsageOriginPrompts),
});
export type UsageOrigins = typeof UsageOrigins.Type;

export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /** Transcript directory device:inode distinguishes machines sharing a hostname and home path. */
  volumeId: Schema.String,
  /**
   * Opaque identity of a directory that the Windows server of a desktop install
   * reads natively and its managed WSL server reads through a drvfs mount. Path
   * and `volumeId` differ between the two sides, so clients treat sources with
   * an equal value as one directory in addition to the fields above.
   */
  physicalSourceId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  /** Total this count; bucket counts double-count sessions spanning days or models. */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
  /** Cached response during refresh; repeat with awaitRefresh for fresh data. */
  refreshing: Schema.optionalKey(Schema.Literal(true)),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

/**
 * Matches a provider's original model ID, before usage model aliases apply. Omit provider to
 * match any; a string provider lets older clients carry selectors for providers they lack.
 */
export const UsageModelSelector = Schema.Struct({
  provider: Schema.optional(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
});
export type UsageModelSelector = typeof UsageModelSelector.Type;

/**
 * A kind of work the Usage page splits by: a name, the projects it counts with their worktrees,
 * and folders it counts without them. A shared group's usage is spread over the other groups.
 */
export const UsageWorkGroup = Schema.Struct({
  name: TrimmedNonEmptyString,
  projectIds: Schema.Array(ProjectId),
  folders: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  shared: Schema.optionalKey(Schema.Boolean),
});
export type UsageWorkGroup = typeof UsageWorkGroup.Type;

/** Keeps records matching `include` (all when omitted) and not matching `exclude`. */
export const UsageModelFilter = Schema.Struct({
  include: Schema.optional(Schema.Array(UsageModelSelector)),
  exclude: Schema.optional(Schema.Array(UsageModelSelector)),
});
export type UsageModelFilter = typeof UsageModelFilter.Type;

export const UsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA bucketing zone; offsets fail across DST boundaries. */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  untilTime: Schema.optional(TrimmedNonEmptyString),
  awaitRefresh: Schema.optional(Schema.Boolean),
  /** Accept an immediate answer from the last scan; its sources are marked refreshing. */
  provisional: Schema.optional(Schema.Boolean),
  modelFilter: Schema.optional(UsageModelFilter),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

/** A dated note the server owner keeps in `usage-annotations.json`, drawn on the Usage chart. */
export const UsageAnnotation = Schema.Struct({
  date: UsageDay,
  label: TrimmedNonEmptyString,
  /** A logo drawn after the label. */
  logo: Schema.optional(Schema.Literals(["t3"])),
});
export type UsageAnnotation = typeof UsageAnnotation.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: ForwardCompatibleArray(UsageBucket),
  sources: ForwardCompatibleArray(UsageSource),
  pricing: UsagePricing,
  scanDurationMs: NonNegativeInt,
  /** The filter the server applied; absent means unfiltered, including servers that predate filters. */
  modelFilter: Schema.optional(UsageModelFilter),
  /** Absent when the server cannot read its T3 prompts, including servers that predate origins. */
  origins: Schema.optional(UsageOrigins),
  /** The `usageWorkGroups` names in settings order; absent from servers that predate them. */
  workGroups: Schema.optional(Schema.Array(Schema.String)),
  /** Kinds of work clients spread over the other groups: shared group names, `""` for Other. */
  sharedWork: Schema.optional(Schema.Array(Schema.String)),
  /** Absent when the server has no annotations file. */
  annotations: Schema.optional(ForwardCompatibleArray(UsageAnnotation)),
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
