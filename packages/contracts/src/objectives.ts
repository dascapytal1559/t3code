import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A calendar day, `YYYY-MM-DD`, with no time or zone. */
export const ObjectivesDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || "Expected a real YYYY-MM-DD day.",
  ),
);

/**
 * The user's high level objectives, which FirstMate pushes over MCP (`t3_objectives_set`) and the
 * Bridge tab shows above its decisions. FirstMate is the only writer.
 */
export const Objectives = Schema.Struct({
  /** Markdown, normally one bullet per objective: a bold name, then a sentence or two. */
  markdown: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
  /** The day FirstMate last reviewed them with the user. */
  lastReviewed: Schema.optionalKey(ObjectivesDay),
});
export type Objectives = typeof Objectives.Type;
