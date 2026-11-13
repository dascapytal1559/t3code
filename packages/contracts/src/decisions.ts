import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * The decisions FirstMate needs from the user: one list per environment, which FirstMate replaces
 * whole over MCP (`t3_decisions_set`) and each item's thread card in the sidebar shows. A reply
 * goes to the chat the list names in `replyTo`. Bounded so the list stays small; pictures and
 * reports travel as paths.
 */

const DecisionText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const DecisionTime = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)) || "Expected an ISO date-time."),
);

/** FirstMate's messages explain the options; an older sender's `detail` is dropped on decode. */
const DecisionOption = Schema.Struct({
  label: DecisionText(200),
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
  /** `read`: a finished report with nothing to decide. Absent means a decision. */
  kind: Schema.optional(Schema.Literals(["decision", "read"])),
  /** The thread whose card carries the item; `finished` when its work is done. */
  thread: Schema.optional(Schema.Struct({ id: ThreadId, finished: Schema.Boolean })),
  /** The user put it off at `at`, until `until` or, when null, until they bring it back. */
  snoozed: Schema.optional(Schema.Struct({ at: DecisionTime, until: Schema.NullOr(DecisionTime) })),
};

/** A decision as FirstMate sends it. An older sender's `wakeAt` is read as a snooze until then. */
export const Decision = Schema.Struct({
  ...decisionFields,
  wakeAt: Schema.optional(DecisionTime),
});
export type Decision = typeof Decision.Type;

/** The action types: the user's three, and T3's own record of an archived or restored thread. */
export const DecisionActionType = Schema.Literals([
  "snooze",
  "unsnooze",
  "archive",
  "thread-archived",
  "thread-unarchived",
]);
export type DecisionActionType = typeof DecisionActionType.Type;

/**
 * Something the user did to an item, logged until FirstMate applies it to its own records and
 * acknowledges it. Clients show the item as if it were applied meanwhile.
 */
export const DecisionAction = Schema.Struct({
  seq: PositiveInt,
  /** A retry with the same id adds nothing. */
  commandId: CommandId,
  itemId: decisionFields.id,
  /** The item's revision the user saw. */
  revision: PositiveInt,
  type: DecisionActionType,
  /** For `snooze`: when the item returns, or null to wait until it is brought back. */
  until: Schema.optional(Schema.NullOr(DecisionTime)),
  at: DecisionTime,
});
export type DecisionAction = typeof DecisionAction.Type;

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
  /** FirstMate refused the user's last action on this version, saying why. */
  refused: Schema.optional(
    Schema.Struct({
      type: DecisionActionType,
      message: Schema.optional(DecisionText(500)),
      at: DecisionTime,
    }),
  ),
});
export type StoredDecision = typeof StoredDecision.Type;

export const DecisionsState = Schema.Struct({
  /** FirstMate's chat, where replies are sent. Null until FirstMate sets a list. */
  replyTo: Schema.NullOr(ThreadId),
  decisions: Schema.Array(StoredDecision),
  /** The user's actions FirstMate has not acknowledged yet, oldest first. */
  actions: Schema.Array(DecisionAction).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The last action's `seq`, so a new one never reuses an acknowledged one's. */
  lastActionSeq: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
});
export type DecisionsState = typeof DecisionsState.Type;

export const EMPTY_DECISIONS_STATE: DecisionsState = {
  replyTo: null,
  decisions: [],
  actions: [],
  lastActionSeq: 0,
};

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

type DecisionEntries = { readonly entries: ReadonlyArray<Pick<DecisionEntry, "at" | "kind">> };

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
  /** The reply waits behind FirstMate's turn. */
  queued: Schema.Boolean,
});
export type DecisionReplyResult = typeof DecisionReplyResult.Type;

/** The user snoozes, brings back or archives an item from its card. */
export const DecisionActInput = Schema.Struct({
  decisionId: decisionFields.id,
  /** A retry with the same id adds nothing. */
  commandId: CommandId,
  /** The revision the user saw; Archive on a newer one is refused, so the user reads it first. */
  revision: PositiveInt,
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literal("snooze"), until: Schema.NullOr(DecisionTime) }),
    Schema.Struct({ type: Schema.Literal("unsnooze") }),
    Schema.Struct({ type: Schema.Literal("archive") }),
  ]),
});
export type DecisionActInput = typeof DecisionActInput.Type;

export const DecisionActResult = Schema.Struct({ seq: PositiveInt });
export type DecisionActResult = typeof DecisionActResult.Type;

export class DecisionActError extends Schema.TaggedError<DecisionActError>()("DecisionActError", {
  decisionId: decisionFields.id,
  reason: Schema.Literals(["not-found", "updated", "failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "This item is no longer waiting on you.";
      case "updated":
        return "FirstMate updated this item since you opened it. Read the update first.";
      case "failed":
        return "Could not save that.";
    }
  }
}

/** FirstMate's side: acknowledge applied actions and read, or wait for, the next ones. */
export const DecisionActionsInput = Schema.Struct({
  /** Return only actions with a higher `seq`. */
  after: Schema.optional(NonNegativeInt),
  /** With none to return, wait up to this long for one. */
  waitMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
  /** Actions applied or refused; they leave the log. A refusal's `message` is shown to the user. */
  ack: Schema.optional(
    Schema.Array(
      Schema.Struct({
        seq: PositiveInt,
        outcome: Schema.Literals(["applied", "refused"]),
        message: Schema.optional(DecisionText(500)),
      }),
    ).check(Schema.isMaxLength(200)),
  ),
});
export type DecisionActionsInput = typeof DecisionActionsInput.Type;

export const DecisionActionsResult = Schema.Struct({
  actions: Schema.Array(DecisionAction),
  lastSeq: NonNegativeInt,
});
export type DecisionActionsResult = typeof DecisionActionsResult.Type;

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
