/**
 * GrokSkills — skill discovery for the `$` picker via `grok inspect --json`.
 *
 * Grok's native discovery spans local, repo, and user `.grok` and `.agents`
 * roots, Claude and Cursor compatibility directories, bundled and plugin
 * skills, and `[skills]` config overrides, deduplicating by name across all
 * of them. Rather than replicate those semantics on the filesystem, discovery
 * asks the CLI for its own post-dedup inventory, the same way the Codex
 * app-server reports its skills. Discovery is best-effort: a missing binary,
 * timeout, or malformed report yields an empty list, never a degraded
 * provider snapshot.
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ProviderSkillProbeError } from "../Errors.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Parse the `skills` section of a `grok inspect --json` report. Entries
 * missing a name or a `SKILL.md` path are skipped; anything else about the
 * payload being unexpected yields an empty list.
 */
export function parseGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  const skills = (parsed as Record<string, unknown>).skills;
  if (!globalThis.Array.isArray(skills)) {
    return [];
  }

  const parsedSkills: ServerProviderSkill[] = [];
  for (const entry of skills) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source =
      typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : undefined;
    const path = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !path) {
      continue;
    }

    const scope = typeof source?.type === "string" ? source.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    // `userInvocable: false` hides a skill from Grok's own slash menu; the
    // `$` picker is the same user-invocation surface, so treat it as disabled.
    parsedSkills.push({
      name,
      path,
      enabled: record.disabled !== true && record.userInvocable !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return parsedSkills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Run `grok inspect --json` in the workspace so local and repo-scope skills
 * resolve the same way a live Grok session would, and return the reported
 * skill inventory. A probe that cannot produce a report (spawn error,
 * timeout, non-zero exit) fails with `ProviderSkillProbeError` so callers
 * can keep a previous inventory instead of accepting an empty one.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  ProviderSkillProbeError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = grokSettings.binaryPath || "grok";
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(
    Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS),
    Effect.mapError(
      (cause) =>
        new ProviderSkillProbeError({
          provider: "grok",
          detail: cause.message ?? String(cause),
          cause,
        }),
    ),
  );
  if (Option.isNone(result)) {
    return yield* new ProviderSkillProbeError({
      provider: "grok",
      detail: `grok inspect timed out after ${GROK_SKILLS_PROBE_TIMEOUT_MS}ms.`,
    });
  }
  if (result.value.code !== 0) {
    return yield* new ProviderSkillProbeError({
      provider: "grok",
      detail: `grok inspect exited with code ${result.value.code}.`,
    });
  }
  return parseGrokInspectSkills(result.value.stdout);
});
