import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The user's high level objectives, which FirstMate pushes over MCP (`t3_objectives_set`) and the
 * Bridge tab shows. FirstMate is the only writer.
 */
export const Objectives = Schema.Struct({
  /** Markdown, normally one bullet per objective: a bold name, then a sentence or two. */
  markdown: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type Objectives = typeof Objectives.Type;

/**
 * FirstMate's model routing table, which it pushes over MCP (`t3_routing_set`) and the Bridge tab
 * shows read-only. FirstMate is the only writer.
 */
export const ModelRouting = Schema.Struct({
  /** A Markdown table: one rule per row (the kind of work, then harness, model, effort and why). */
  markdown: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type ModelRouting = typeof ModelRouting.Type;
