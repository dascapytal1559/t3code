import { UsageDay, UsageOriginReasonUsage } from "@t3tools/contracts";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { jsonFlag, printJson, reportThreadErrors, withThreadTools } from "./thread.ts";

const UsageReasonsResult = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  timeZone: Schema.String,
  tokens: Schema.Number,
  byDefaultTokens: Schema.Number,
  rows: Schema.Array(UsageOriginReasonUsage),
});

const REASON_LABELS: Record<UsageOriginReasonUsage["reason"], string> = {
  typed: "typed",
  inherited: "inherited",
  journal: "journal",
  upkeep: "upkeep",
  terminal: "terminal session",
  unregisteredSession: "unregistered session",
  unmatchedRegistration: "registered, no thread matched",
  lateRecord: "T3 session outside its turns",
  unnamedTurn: "turn nobody named",
  noCause: "no cause",
  untracedCause: "cause reaches no device",
  noPrompt: "turn with no prompt",
  unknownDevice: "unknown device",
  serverPrompt: "server prompt",
  unstamped: "unstamped prompt",
  beforeStamps: "before device stamps",
  archive: "archived history",
  accountOnly: "account-only",
};

/** One line per origin and reason, providers summed; claim kind and folder matches noted. */
function formatUsageReasons(result: typeof UsageReasonsResult.Type): readonly string[] {
  const lines = new Map<string, { label: string; tokens: number; byDefault: boolean }>();
  for (const row of result.rows) {
    const label = [
      row.origin,
      REASON_LABELS[row.reason],
      ...(row.claim === undefined ? [] : [`${row.claim} claim`]),
      ...(row.folder === true ? ["by folder"] : []),
      ...(row.registered === true && row.reason !== "terminal" ? ["by registration"] : []),
    ].join(" · ");
    const line = lines.get(label) ?? { label, tokens: 0, byDefault: row.byDefault };
    line.tokens += row.tokens;
    lines.set(label, line);
  }
  const share = (tokens: number) =>
    result.tokens > 0 ? formatPercent(tokens / result.tokens) : "-";
  const ordered = [...lines.values()].toSorted(
    (a, b) => Number(a.byDefault) - Number(b.byDefault) || b.tokens - a.tokens,
  );
  const evidence = ordered.filter((line) => !line.byDefault);
  const row = (label: string, tokens: number) =>
    `  ${label.padEnd(44)} ${formatTokens(tokens).padStart(8)}  ${share(tokens).padStart(6)}`;
  return [
    `Usage by origin reason, ${result.sinceDay} to ${result.untilDay} (${result.timeZone}): ${formatTokens(result.tokens)} tokens`,
    `Device evidence:${evidence.length === 0 ? " none" : ""}`,
    ...evidence.map((line) => row(line.label, line.tokens)),
    `Computer by default, no device evidence: ${formatTokens(result.byDefaultTokens)} (${share(result.byDefaultTokens)})`,
    ...ordered.filter((line) => line.byDefault).map((line) => row(line.label, line.tokens)),
  ];
}

const usageReasonsCommand = Command.make("reasons", {
  ...projectLocationFlags,
  days: Flag.Int("days").pipe(
    Flag.withDescription("How many days, ending on --until-day. Defaults to 7."),
    Flag.optional,
  ),
  untilDay: Flag.String("until-day").pipe(
    Flag.withDescription("Last day of the window (YYYY-MM-DD). Defaults to today."),
    Flag.optional,
  ),
  timeZone: Flag.String("time-zone").pipe(
    Flag.withDescription("IANA time zone the days are in. Defaults to the server's."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the running server's usage by why it counts to the phone or computer, and what counts to the computer only by default.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.usage.reasons")(function* (tools) {
        const result = yield* tools.call(
          "t3_usage_reasons",
          {
            ...Option.match(flags.days, { onNone: () => ({}), onSome: (days) => ({ days }) }),
            ...Option.match(flags.untilDay, {
              onNone: () => ({}),
              onSome: (untilDay) => ({ untilDay }),
            }),
            ...Option.match(flags.timeZone, {
              onNone: () => ({}),
              onSome: (timeZone) => ({ timeZone }),
            }),
          },
          UsageReasonsResult,
        );
        if (flags.json) return yield* printJson(result);
        for (const line of formatUsageReasons(result)) yield* Console.log(line);
      }),
    ).pipe(reportThreadErrors),
  ),
);

export const usageCommand = Command.make("usage").pipe(
  Command.withDescription("Read usage from the running server."),
  Command.withSubcommands([usageReasonsCommand]),
);
