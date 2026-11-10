import * as Schema from "effect/Schema";

import { CommandId, MessageId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The user's standing rules for FirstMate, which FirstMate replaces whole over MCP
 * (`t3_rules_set`) and the Bridge tab lists. A pending rule carries FirstMate's recommendation;
 * agreeing with it sends one message to FirstMate's chat, the decisions' `replyTo`.
 */

const RuleText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const RuleChoice = Schema.Literals(["keep", "keep-narrower", "make-rule", "fact", "drop"]);
export type RuleChoice = typeof RuleChoice.Type;

export const RuleRecommendation = Schema.Struct({
  choice: RuleChoice,
  /** What the chip says, such as "Keep narrower". */
  label: RuleText(200),
  /** One line on why. */
  note: Schema.optional(RuleText(2_000)),
  /** The narrower or rewritten wording. */
  proposedText: Schema.optional(RuleText(2_000)),
});
export type RuleRecommendation = typeof RuleRecommendation.Type;

const ruleFields = {
  /** FirstMate's stable id, such as "R010". */
  id: RuleText(200),
  /** The heading it sits under; groups show in the order they first appear. */
  group: RuleText(200),
  /** The file it lives in. */
  source: Schema.optional(RuleText(1_000)),
  /** Its current wording, plain text or inline Markdown. */
  text: RuleText(2_000),
};

export const Rule = Schema.Union([
  Schema.Struct({
    ...ruleFields,
    status: Schema.Literal("approved"),
    approvedOn: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { expected: "a YYYY-MM-DD date" }),
      ),
    ),
  }),
  Schema.Struct({
    ...ruleFields,
    status: Schema.Literal("pending"),
    recommendation: RuleRecommendation,
  }),
]);
export type Rule = typeof Rule.Type;
export type PendingRule = Extract<Rule, { readonly status: "pending" }>;

const MAX_RULES = 400;

export const RulesSetInput = Schema.Struct({
  /** The whole list; empty clears the section. */
  rules: Schema.Array(Rule).check(
    Schema.isMaxLength(MAX_RULES),
    Schema.makeFilter(
      (rules) =>
        new Set(rules.map((rule) => rule.id)).size === rules.length ||
        "Each rule needs its own id.",
    ),
  ),
});
export type RulesSetInput = typeof RulesSetInput.Type;

export const RulesState = Schema.Struct({
  rules: Schema.Array(Rule),
  /** Pending rules whose recommendation the user agreed to, until a changed rule replaces it. */
  sent: Schema.Array(ruleFields.id),
});
export type RulesState = typeof RulesState.Type;

export const EMPTY_RULES_STATE: RulesState = { rules: [], sent: [] };

/** What T3 stored, for the caller to check against what it sent. */
export const RulesSetResult = Schema.Struct({
  rules: Schema.Number,
  pending: Schema.Number,
  /** Ids of pending rules whose recommendation the user has agreed to. */
  sent: Schema.Array(ruleFields.id),
});
export type RulesSetResult = typeof RulesSetResult.Type;

export const RuleAnswerInput = Schema.Struct({
  ruleId: ruleFields.id,
  /** The recommendation the user agreed to; a changed one refuses, so the user reads it first. */
  recommendation: RuleRecommendation,
  /** A retry with the same id replays the first answer. */
  commandId: CommandId,
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type RuleAnswerInput = typeof RuleAnswerInput.Type;

export const RuleAnswerResult = Schema.Struct({
  coordinatorThreadId: ThreadId,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
});
export type RuleAnswerResult = typeof RuleAnswerResult.Type;

export class RuleAnswerError extends Schema.TaggedError<RuleAnswerError>()("RuleAnswerError", {
  ruleId: ruleFields.id,
  /** `updated`: the recommendation changed since the user read it; nothing was sent. */
  reason: Schema.Literals(["not-found", "no-coordinator", "updated", "failed"]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "This rule is no longer waiting on you.";
      case "no-coordinator":
        return "FirstMate's chat, where this answer would go, is gone.";
      case "updated":
        return "FirstMate changed this recommendation while you were reading. Read it, then agree again.";
      case "failed":
        return this.detail ?? "Could not send the answer.";
    }
  }
}

/** The message agreeing with a recommendation: a sentence, then a line FirstMate parses. */
export function formatRuleAnswer(rule: Pick<PendingRule, "id" | "recommendation">): string {
  return [
    `Agree with your recommendation on rule ${rule.id}: ${rule.recommendation.label}.`,
    `rule-answer: ${rule.id} ${rule.recommendation.choice}`,
  ].join("\n");
}
