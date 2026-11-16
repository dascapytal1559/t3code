import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2CausedBy, OrchestrationV2UsageOrigin } from "./orchestrationV2.ts";

/**
 * A pending request to restart this T3 server, such as FirstMate installing a new build. While one
 * is pending no turn starts; sends queue, held, and run after the restart. The server never
 * restarts itself: whoever asked quits it once it reports drained. It is saved to disk, so the
 * next server start knows what the restart was for, and that start clears it.
 */
export const RestartRequest = Schema.Struct({
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  requestedBy: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
  /** The prompt whose work the restart installs; the restart note and continuations count to it. */
  causedBy: Schema.optional(OrchestrationV2CausedBy),
  /** Fork: where the work it installs counts, bound by value when it was requested. */
  usageOrigin: Schema.optional(OrchestrationV2UsageOrigin),
});
export type RestartRequest = typeof RestartRequest.Type;

export const RestartRequestState = Schema.Struct({
  request: Schema.NullOr(RestartRequest),
});
export type RestartRequestState = typeof RestartRequestState.Type;

export const RestartRequestStatus = Schema.Struct({
  pending: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  requestedAt: Schema.NullOr(IsoDateTime),
  /** The pending request's cause. Servers without causes omit it. */
  causedBy: Schema.optional(Schema.NullOr(OrchestrationV2CausedBy)),
  /** Threads with a turn in flight, in any project, the caller's own included. */
  activeTurns: NonNegativeInt,
  /** Pending, and no turn in flight: safe to restart now. */
  drained: Schema.Boolean,
  /** When this server process started; it changes on every restart, and restart notes quote it. */
  serverStartedAt: IsoDateTime,
});
export type RestartRequestStatus = typeof RestartRequestStatus.Type;
