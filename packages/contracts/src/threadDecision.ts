import * as Schema from "effect/Schema";

import { MessageId, PositiveInt, ThreadId } from "./baseSchemas.ts";
import {
  DecisionOption,
  DecisionText,
  DecisionTime,
  decisionChangedAt,
  decisionEntryFields,
  decisionSince,
  decisionUpdatedAt,
} from "./decisions.ts";

/**
 * A decision held by its own thread, the shape FirstMate used before the decisions list
 * (`decisions.ts`). The Bridge no longer reads these; the thread stays hidden until FirstMate
 * archives it.
 */

// The thread list entry still carries these times under their old names.
export const threadDecisionUpdatedAt = decisionUpdatedAt;
export const threadDecisionChangedAt = decisionChangedAt;
export const threadDecisionSince = decisionSince;

const ThreadDecisionEntry = Schema.Struct({
  ...decisionEntryFields,
  /** Where the message sits in the coordinator's chat; `id` is null until it is known. */
  message: Schema.optional(
    Schema.Struct({ thread: ThreadId, id: Schema.optional(Schema.NullOr(MessageId)) }),
  ),
});

const decisionFields = {
  taskId: DecisionText(200),
  title: DecisionText(200),
  projectName: Schema.optional(DecisionText(200)),
  since: Schema.optional(DecisionTime),
  question: DecisionText(4_000),
  options: Schema.Array(DecisionOption).check(Schema.isMaxLength(12)),
  entries: Schema.Array(ThreadDecisionEntry).check(Schema.isMaxLength(24)),
};

export const ThreadDecision = Schema.Struct({ ...decisionFields, revision: PositiveInt });
export type ThreadDecision = typeof ThreadDecision.Type;

/** What a coordinator sends; without `revision` the server uses the stored one plus one. */
export const ThreadDecisionInput = Schema.Struct({
  ...decisionFields,
  revision: Schema.optional(PositiveInt),
});
export type ThreadDecisionInput = typeof ThreadDecisionInput.Type;
