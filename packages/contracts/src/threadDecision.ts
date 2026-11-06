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
 * A decision FirstMate needs from the user, held by its own thread. The thread has no agent: a
 * reply goes to the coordinator named by the thread's `decisionOf`. Bounded so thread events stay
 * small; pictures and reports travel as paths.
 */

const Text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const DecisionTime = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)) || "Expected an ISO date-time."),
);

export const ThreadDecisionOption = Schema.Struct({
  label: Text(200),
  detail: Schema.optional(Text(2_000)),
});
export type ThreadDecisionOption = typeof ThreadDecisionOption.Type;

export const ThreadDecisionAttachment = Schema.Struct({
  /** Such as report, picture or link; the client draws pictures by their path's extension. */
  kind: Text(32),
  path: Text(2_048),
  label: Schema.optional(Text(200)),
});
export type ThreadDecisionAttachment = typeof ThreadDecisionAttachment.Type;

export const ThreadDecisionEntry = Schema.Struct({
  at: DecisionTime,
  kind: Schema.Literals(["raised", "update"]),
  /** One line on what an update changed. */
  changed: Schema.optional(Text(500)),
  /** The coordinator's message as sent, Markdown. */
  text: Text(8_192),
  /** Where the message sits in the coordinator's chat; `id` is null until it is known. */
  message: Schema.optional(
    Schema.Struct({ thread: ThreadId, id: Schema.optional(Schema.NullOr(MessageId)) }),
  ),
  attachments: Schema.optional(
    Schema.Array(ThreadDecisionAttachment).check(Schema.isMaxLength(12)),
  ),
});
export type ThreadDecisionEntry = typeof ThreadDecisionEntry.Type;

const decisionFields = {
  taskId: Text(200),
  title: Text(200),
  /** The project the decision is about, which its Needs me row shows instead of the thread's. */
  projectName: Schema.optional(Text(200)),
  /** When the call started waiting on the user, which its Needs me row counts its age from. */
  since: Schema.optional(DecisionTime),
  question: Text(4_000),
  options: Schema.Array(ThreadDecisionOption).check(Schema.isMaxLength(12)),
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

/** The time of the decision's latest entry, which Needs me sorts by and marks updates with. */
export function threadDecisionUpdatedAt(
  decision: Pick<ThreadDecision, "entries"> | null | undefined,
): string | null {
  let latest: string | null = null;
  for (const entry of decision?.entries ?? []) {
    if (latest === null || Date.parse(entry.at) > Date.parse(latest)) latest = entry.at;
  }
  return latest;
}

/** When the decision began waiting: its `since`, else its earliest entry (the raised one). */
export function threadDecisionSince(
  decision: Pick<ThreadDecision, "since" | "entries"> | null | undefined,
): string | null {
  if (decision?.since !== undefined) return decision.since;
  let earliest: string | null = null;
  for (const entry of decision?.entries ?? []) {
    if (earliest === null || Date.parse(entry.at) < Date.parse(earliest)) earliest = entry.at;
  }
  return earliest;
}

export const ThreadDecisionReplyInput = Schema.Struct({
  /** The decision thread. */
  threadId: ThreadId,
  /** A retry with the same id replays the first reply. */
  commandId: CommandId,
  text: Text(120_000),
  /** The revision the user read; a newer one refuses, so the user sees the update first. */
  revision: Schema.optional(PositiveInt),
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type ThreadDecisionReplyInput = typeof ThreadDecisionReplyInput.Type;

export const ThreadDecisionReplyResult = Schema.Struct({
  coordinatorThreadId: ThreadId,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  /** The reply waits behind the coordinator's turn, so Undo can still take it back. */
  queued: Schema.Boolean,
});
export type ThreadDecisionReplyResult = typeof ThreadDecisionReplyResult.Type;

export const ThreadDecisionUndoReplyInput = Schema.Struct({
  threadId: ThreadId,
  /** The reply's `commandId`. */
  commandId: CommandId,
});
export type ThreadDecisionUndoReplyInput = typeof ThreadDecisionUndoReplyInput.Type;

export const ThreadDecisionUndoReplyResult = Schema.Struct({
  /** False once the coordinator has started on the reply; the decision then stays settled. */
  withdrawn: Schema.Boolean,
});
export type ThreadDecisionUndoReplyResult = typeof ThreadDecisionUndoReplyResult.Type;

export class ThreadDecisionReplyError extends Schema.TaggedError<ThreadDecisionReplyError>()(
  "ThreadDecisionReplyError",
  {
    threadId: ThreadId,
    /** `updated`: the decision changed since the user read it; nothing was sent. */
    reason: Schema.Literals(["not-a-decision", "no-coordinator", "updated", "failed"]),
    /** What went wrong, when the failure has a message the user can act on. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-decision":
        return "This thread holds no decision to answer.";
      case "no-coordinator":
        return "The coordinator this decision belongs to is gone.";
      case "updated":
        return "FirstMate updated this decision while you were replying. Read the update, then send again.";
      case "failed":
        return this.detail ?? "Could not send the reply.";
    }
  }
}

const THREAD_DECISION_TASK_LINE_PREFIX = "needs-me-task: ";

/**
 * The message a reply sends to the coordinator: a header naming the decision, the task id on its
 * own line for the coordinator to parse, the question quoted, then the user's words. User messages
 * render without raw HTML, so the header is plain Markdown rather than a `<details>` fold.
 */
export function formatThreadDecisionReply(input: {
  readonly decision: Pick<ThreadDecision, "taskId" | "title" | "question">;
  readonly text: string;
}): string {
  const quoted = input.decision.question
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
  return [
    `**Decision · ${input.decision.title}**`,
    `${THREAD_DECISION_TASK_LINE_PREFIX}${input.decision.taskId}`,
    "",
    quoted,
    "",
    input.text.trim(),
  ].join("\n");
}
