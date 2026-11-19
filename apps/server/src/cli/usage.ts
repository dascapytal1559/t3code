import {
  AuthDiagnosticsReadScope,
  USAGE_EXPORT_PATH,
  type UsageOriginReasonUsage,
  UsageOriginReasons,
} from "@t3tools/contracts";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageRelabel from "../usage/UsageRelabel.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  jsonFlag,
  printJson,
  reportThreadErrors,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  withServerSession,
  withThreadTools,
} from "./thread.ts";

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

/** One line per origin and reason, providers summed; claim kind, folder matches and causes noted. */
function formatUsageReasons(result: UsageOriginReasons): readonly string[] {
  const lines = new Map<string, { label: string; tokens: number; byDefault: boolean }>();
  for (const row of result.rows) {
    const label = [
      row.origin,
      REASON_LABELS[row.reason],
      ...(row.claim === undefined ? [] : [`${row.claim} claim`]),
      ...(row.folder === true ? ["by folder"] : []),
      ...(row.registered === true && row.reason !== "terminal" ? ["by registration"] : []),
      ...(row.cause === true ? ["by recorded cause"] : []),
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
          UsageOriginReasons,
        );
        if (flags.json) return yield* printJson(result);
        for (const line of formatUsageReasons(result)) yield* Console.log(line);
      }),
    ).pipe(reportThreadErrors),
  ),
);

const usageExportCommand = Command.make("export", {
  ...projectLocationFlags,
  since: Flag.String("since").pipe(Flag.withDescription("First day of the window (YYYY-MM-DD).")),
  until: Flag.String("until").pipe(
    Flag.withDescription("Last day of the window (YYYY-MM-DD). Defaults to today."),
    Flag.optional,
  ),
  timeZone: Flag.String("time-zone").pipe(
    Flag.withDescription("IANA time zone the days are in. Defaults to the server's."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Print the running server's usage as JSON lines, one per model call, as Usage counted it.",
  ),
  Command.withHandler((flags) =>
    // Quiet logs, as for --json: stdout carries only the records.
    withServerSession(
      { ...flags, json: true },
      (auth) =>
        auth.issueSession({
          scopes: [AuthDiagnosticsReadScope],
          ttl: Duration.minutes(10),
          label: "t3 usage export",
        }),
      Effect.fn("cli.usage.export")(function* ({ origin, token }) {
        const url = new URL(USAGE_EXPORT_PATH, origin);
        url.searchParams.set("since", flags.since);
        Option.map(flags.until, (until) => url.searchParams.set("until", until));
        Option.map(flags.timeZone, (zone) => url.searchParams.set("timeZone", zone));
        const unreachable = (cause: unknown) => new ThreadServerUnreachableError({ origin, cause });
        const response = yield* HttpClientRequest.get(url).pipe(
          HttpClientRequest.bearerToken(token),
          (yield* HttpClient.HttpClient).execute,
          Effect.mapError(unreachable),
        );
        if (response.status !== 200) {
          const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new ThreadToolFailedError({
            tool: "usage export",
            detail: detail.trim() || `The server answered HTTP ${response.status}.`,
          });
        }
        const stdio = yield* Stdio.Stdio;
        yield* response.stream.pipe(
          Stream.run(stdio.stdout({ endOnDone: false })),
          Effect.mapError(unreachable),
        );
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer), reportThreadErrors),
  ),
);

function formatRelabelPlan(plan: UsageRelabel.RelabelPlan, reason: string): readonly string[] {
  const moves = Object.entries(plan.moves)
    .map(([move, rows]) => `${move.replace(">", " to ")} ${rows}`)
    .join(", ");
  const { toChange, alreadyNew, differs, missing, notClosed } = plan.states;
  return [
    `Manifest ${plan.manifestSha256.slice(0, 12)}: ${plan.rows} rows. ${reason}`,
    `  To change: ${toChange}${moves === "" ? "" : ` (${moves})`}`,
    `  Already relabelled: ${alreadyNew}. Differ: ${differs}. Missing: ${missing}. Not closed yet: ${notClosed}.`,
    ...plan.problems.map((problem) => `    ${problem}`),
    plan.appliedAs !== null
      ? `Applied already as ${plan.appliedAs}.`
      : toChange === plan.rows && plan.rows > 0
        ? "Ready to apply."
        : "Cannot apply: every row must hold its old label.",
  ];
}

const usageRelabelCommand = Command.make("relabel", {
  ...projectLocationFlags,
  manifest: Flag.String("manifest").pipe(
    Flag.withDescription("The relabel manifest (JSON): each closed row, its old and new label."),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Check the manifest against the database, read-only."),
    Flag.withDefault(false),
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Back up the closed labels, then apply the manifest as one change set."),
    Flag.withDefault(false),
  ),
  undo: Flag.String("undo").pipe(
    Flag.withDescription("Restore every row of an applied change set to its old label."),
    Flag.optional,
  ),
  list: Flag.Boolean("list").pipe(
    Flag.withDescription("List applied change sets."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Correct labels the daily close wrote down, from an audited manifest. Safe beside a running server.",
  ),
  Command.withHandler(
    Effect.fn("cli.usage.relabel")(function* (flags) {
      const modes = [
        Option.isSome(flags.manifest) && flags.dryRun,
        Option.isSome(flags.manifest) && flags.apply,
        Option.isSome(flags.undo),
        flags.list,
      ].filter(Boolean).length;
      const mixed =
        (flags.dryRun || flags.apply) !== Option.isSome(flags.manifest) ||
        (flags.dryRun && flags.apply);
      if (modes !== 1 || mixed) {
        return yield* new UsageRelabel.RelabelRefused({
          detail:
            "give one of --manifest <file> --dry-run, --manifest <file> --apply, --undo <id>, or --list.",
        });
      }
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: flags.json,
      });
      const show = <A>(value: A, lines: (value: A) => readonly string[]) =>
        flags.json ? printJson(value) : Effect.forEach(lines(value), (line) => Console.log(line));
      // A dry run and a listing open the database read-only, so they write nothing at all.
      const readOnly = NodeSqliteClient.layer({ filename: config.dbPath, readonly: true });
      const writable = SqlitePersistence.layerCliConfig.pipe(
        Layer.provide(ServerConfig.layer(config)),
      );
      const readManifest = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = Option.getOrThrow(flags.manifest);
        return yield* UsageRelabel.decodeManifest(yield* fs.readFileString(file));
      });

      if (flags.list) {
        const records = yield* UsageRelabel.listRelabels().pipe(Effect.provide(readOnly));
        return yield* show(records, (list) =>
          list.length === 0
            ? ["No relabels applied."]
            : list.map(
                (record) =>
                  `${record.id}  ${record.appliedAt}  ${record.rows} rows  ${record.undoneAt === null ? "applied" : `undone ${record.undoneAt}`}  ${record.reason}`,
              ),
        );
      }
      if (Option.isSome(flags.undo)) {
        const undone = yield* UsageRelabel.undoRelabel(flags.undo.value).pipe(
          Effect.provide(writable),
        );
        return yield* show(undone, (value) => [
          `Undid ${value.id}: ${value.rows} rows restored to their old labels.`,
        ]);
      }
      const manifest = yield* readManifest;
      if (flags.dryRun) {
        const plan = yield* UsageRelabel.planRelabel(manifest).pipe(Effect.provide(readOnly));
        return yield* show(plan, (value) => formatRelabelPlan(value, manifest.reason));
      }
      const path = yield* Path.Path;
      const applied = yield* UsageRelabel.applyRelabel({
        manifest,
        backupDir: path.join(config.stateDir, "usage-relabels"),
      }).pipe(Effect.provide(writable));
      return yield* show(applied, (value) => [
        `Applied ${value.id}: ${value.rows} rows (${Object.entries(value.moves)
          .map(([move, rows]) => `${move.replace(">", " to ")} ${rows}`)
          .join(", ")}).`,
        `Backup of the closed labels: ${value.backupPath}`,
        `Undo with: t3 usage relabel --undo ${value.id}`,
      ]);
    }),
  ),
);

export const usageCommand = Command.make("usage").pipe(
  Command.withDescription("Read usage from the running server, or correct its closed labels."),
  Command.withSubcommands([usageReasonsCommand, usageExportCommand, usageRelabelCommand]),
);
