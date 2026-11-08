import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The user's high level objectives, which FirstMate pushes over MCP (`t3_objectives_set`) and the
 * Bridge tab shows above its decisions. FirstMate is the only writer.
 */
export const Objectives = Schema.Struct({
  /** Markdown, normally one bullet per objective: a bold name, then a sentence or two. */
  markdown: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type Objectives = typeof Objectives.Type;
