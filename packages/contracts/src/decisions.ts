import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * The decisions FirstMate needs from the user: one list per environment, which FirstMate replaces
 * whole over MCP (`t3_decisions_set`) and the Bridge tab shows. A reply goes to the chat the list
 * names in `replyTo`. Bounded so the list stays small; pictures and reports travel as paths.
 */

const DecisionText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const DecisionTime = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)) || "Expected an ISO date-time."),
);

const DecisionOption = Schema.Struct({
  label: DecisionText(200),
  detail: Schema.optional(DecisionText(2_000)),
});

export const DecisionAttachment = Schema.Struct({
  /** Such as report, picture or link; the client draws pictures by their path's extension. */
  kind: DecisionText(32),
  path: DecisionText(2_048),
  label: Schema.optional(DecisionText(200)),
});
export type DecisionAttachment = typeof DecisionAttachment.Type;

const decisionEntryFields = {
  at: DecisionTime,
  kind: Schema.Literals(["raised", "update"]),
  /** One line on what an update changed. */
  changed: Schema.optional(DecisionText(500)),
  /** FirstMate's message as sent, Markdown. */
  text: DecisionText(8_192),
  attachments: Schema.optional(Schema.Array(DecisionAttachment).check(Schema.isMaxLength(12))),
};

export const DecisionEntry = Schema.Struct(decisionEntryFields);
export type DecisionEntry = typeof DecisionEntry.Type;

const decisionFields = {
  /** FirstMate's own id for the decision, its task id. Replies name it back to FirstMate. */
  id: DecisionText(200),
  title: DecisionText(200),
  /** The project the decision is about, which its row shows. */
  projectName: Schema.optional(DecisionText(200)),
  /** When the decision started waiting on the user, which its row counts its age from. */
  since: Schema.optional(DecisionTime),
  question: DecisionText(4_000),
  options: Schema.Array(DecisionOption).check(Schema.isMaxLength(12)),
  entries: Schema.Array(DecisionEntry).check(Schema.isMaxLength(24)),
  /** FirstMate's version of the decision; a reply written against an older one is refused. */
  revision: PositiveInt,
  /** Set: the decision waits under Scheduled until then. */
  wakeAt: Schema.optional(DecisionTime),
};

/** A decision as FirstMate sends it. */
export const Decision = Schema.Struct(decisionFields);
export type Decision = typeof Decision.Type;

/** A decision as T3 keeps it. `answered` is T3's own: the user replied to this version of it. */
export const StoredDecision = Schema.Struct({
  ...decisionFields,
  answered: Schema.optional(
    Schema.Struct({
      /** The reply's `commandId`, which Undo names. */
      commandId: CommandId,
      at: DecisionTime,
    }),
  ),
});
export type StoredDecision = typeof StoredDecision.Type;

export const DecisionsState = Schema.Struct({
  /** FirstMate's chat, where replies are sent. Null until FirstMate sets a list. */
  replyTo: Schema.NullOr(ThreadId),
  decisions: Schema.Array(StoredDecision),
});
export type DecisionsState = typeof DecisionsState.Type;

export const EMPTY_DECISIONS_STATE: DecisionsState = { replyTo: null, decisions: [] };

const MAX_DECISIONS = 200;

export const DecisionsSetInput = Schema.Struct({
  replyTo: ThreadId,
  /** The whole list. A decision left out is gone. */
  decisions: Schema.Array(Decision).check(
    Schema.isMaxLength(MAX_DECISIONS),
    Schema.makeFilter(
      (decisions) =>
        new Set(decisions.map((decision) => decision.id)).size === decisions.length ||
        "Each decision needs its own id.",
    ),
  ),
});
export type DecisionsSetInput = typeof DecisionsSetInput.Type;

/** What T3 stored, for the caller to check against what it sent. */
export const DecisionsSetResult = Schema.Struct({
  replyTo: Schema.NullOr(ThreadId),
  decisions: Schema.Array(
    Schema.Struct({
      id: decisionFields.id,
      revision: PositiveInt,
      /** The user has replied to this version; FirstMate's chat holds the reply. */
      answered: Schema.Boolean,
    }),
  ),
});
export type DecisionsSetResult = typeof DecisionsSetResult.Type;

function latestEntryAt(
  entries: ReadonlyArray<Pick<DecisionEntry, "at" | "kind">>,
  kind?: DecisionEntry["kind"],
): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (kind !== undefined && entry.kind !== kind) continue;
    if (latest === null || Date.parse(entry.at) > Date.parse(latest)) latest = entry.at;
  }
  return latest;
}

type DecisionEntries = { readonly entries: ReadonlyArray<Pick<DecisionEntry, "at" | "kind">> };

/** The time of the decision's latest entry, which the Bridge sorts by. */
export function decisionUpdatedAt(decision: DecisionEntries | null | undefined): string | null {
  return latestEntryAt(decision?.entries ?? []);
}

/** The time of the latest real change (an `update` entry), so rewording the raise ages nothing. */
export function decisionChangedAt(decision: DecisionEntries | null | undefined): string | null {
  return latestEntryAt(decision?.entries ?? [], "update");
}

/** When the decision began waiting: its `since`, else its earliest entry (the raised one). */
export function decisionSince(
  decision: (DecisionEntries & { readonly since?: string | undefined }) | null | undefined,
): string | null {
  if (decision?.since !== undefined) return decision.since;
  let earliest: string | null = null;
  for (const entry of decision?.entries ?? []) {
    if (earliest === null || Date.parse(entry.at) < Date.parse(earliest)) earliest = entry.at;
  }
  return earliest;
}

export const DecisionReplyInput = Schema.Struct({
  decisionId: decisionFields.id,
  /** A retry with the same id replays the first reply. */
  commandId: CommandId,
  text: DecisionText(120_000),
  /** The revision the user read; a newer one refuses, so the user sees the update first. */
  revision: Schema.optional(PositiveInt),
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type DecisionReplyInput = typeof DecisionReplyInput.Type;

export const DecisionReplyResult = Schema.Struct({
  coordinatorThreadId: ThreadId,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  /** The reply waits behind FirstMate's turn, so Undo can still take it back. */
  queued: Schema.Boolean,
});
export type DecisionReplyResult = typeof DecisionReplyResult.Type;

export const DecisionUndoReplyInput = Schema.Struct({
  decisionId: decisionFields.id,
  /** The reply's `commandId`. */
  commandId: CommandId,
});
export type DecisionUndoReplyInput = typeof DecisionUndoReplyInput.Type;

export const DecisionUndoReplyResult = Schema.Struct({
  /** False once FirstMate has started on the reply; the decision then stays answered. */
  withdrawn: Schema.Boolean,
});
export type DecisionUndoReplyResult = typeof DecisionUndoReplyResult.Type;

export class DecisionReplyError extends Schema.TaggedError<DecisionReplyError>()(
  "DecisionReplyError",
  {
    decisionId: decisionFields.id,
    /** `updated`: the decision changed since the user read it; nothing was sent. */
    reason: Schema.Literals(["not-found", "no-coordinator", "updated", "failed"]),
    /** What went wrong, when the failure has a message the user can act on. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "This decision is no longer waiting on you.";
      case "no-coordinator":
        return "FirstMate's chat, where this reply would go, is gone.";
      case "updated":
        return "FirstMate updated this decision while you were replying. Read the update, then send again.";
      case "failed":
        return this.detail ?? "Could not send the reply.";
    }
  }
}

const DECISION_TASK_LINE_PREFIX = "needs-me-task: ";

/**
 * The message a reply sends to FirstMate: a header naming the decision, its id on its own line
 * for FirstMate to parse, the question quoted, then the user's words. User messages render
 * without raw HTML, so the header is plain Markdown rather than a `<details>` fold.
 */
export function formatDecisionReply(input: {
  readonly decision: Pick<Decision, "id" | "title" | "question">;
  readonly text: string;
}): string {
  const quoted = input.decision.question
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
  return [
    `**Decision · ${input.decision.title}**`,
    `${DECISION_TASK_LINE_PREFIX}${input.decision.id}`,
    "",
    quoted,
    "",
    input.text.trim(),
  ].join("\n");
}
