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

/**
 * FirstMate's model routing table, which it pushes over MCP (`t3_routing_set`) and the Bridge tab
 * shows read-only after its decisions. FirstMate is the only writer.
 */
export const ModelRouting = Schema.Struct({
  /** A Markdown table: one rule per row (the kind of work, then harness, model, effort and why). */
  markdown: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type ModelRouting = typeof ModelRouting.Type;

/** A pinned report's key: FirstMate's own id for it, such as its task id. Pinning it again replaces it. */
export const PinnedReportId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type PinnedReportId = typeof PinnedReportId.Type;

/**
 * A finished report FirstMate pins to the Bridge's Reports section (`t3_reports_pin`). The user
 * opens it from there and unpins it there or FirstMate does (`t3_reports_unpin`).
 */
export const PinnedReport = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** One line saying what the report found. */
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  /** The report: an absolute path to its file on the server's machine, or an http(s) link. */
  location: TrimmedNonEmptyString.check(
    Schema.isMaxLength(2_000),
    Schema.isPattern(/^(?:https?:\/\/|\/|[A-Za-z]:[\\/])/),
  ),
  /** When it was pinned, an ISO 8601 date-time the server stamps. */
  pinnedAt: Schema.String,
});
export type PinnedReport = typeof PinnedReport.Type;

/** The pinned reports as the Bridge lists them: newest pin first. */
export function pinnedReportsNewestFirst(
  reports: Readonly<Record<string, PinnedReport>>,
): ReadonlyArray<PinnedReport & { readonly id: string }> {
  return Object.entries(reports)
    .map(([id, report]) => ({ id, ...report }))
    .sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || a.id.localeCompare(b.id));
}
