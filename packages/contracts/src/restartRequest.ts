import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A pending request to restart this T3 server, such as FirstMate installing a new build. While one
 * is pending no turn starts; sends queue, held, and run after the restart. The server never
 * restarts itself: whoever asked quits it once it reports drained. Server start clears it.
 */
export const RestartRequest = Schema.Struct({
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  requestedBy: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
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
  /** Threads with a turn in flight, in any project, the caller's own included. */
  activeTurns: NonNegativeInt,
  /** Pending, and no turn in flight: safe to restart now. */
  drained: Schema.Boolean,
});
export type RestartRequestStatus = typeof RestartRequestStatus.Type;
