/**
 * ProviderSkillDiscovery — contextual skill inventories for the composer's
 * `$` picker, keyed by `(providerInstanceId, realpath(cwd))`.
 *
 * Served stale-while-revalidate: a cached inventory returns immediately
 * while a fresh probe runs in the background for the next request; a cold
 * key waits for its first probe, with concurrent requests coalesced onto
 * one probe. A `null` cwd (directoryless threads) and providers without
 * contextual discovery answer from the instance's snapshot baseline. A
 * failed probe keeps the last good inventory.
 *
 * @module provider/Services/ProviderSkillDiscovery
 */
import type {
  ServerProviderSkill,
  ServerProviderSkillsInput,
  ServerProviderSkillsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { causeErrorTag } from "@t3tools/shared/observability";

import type { ProviderSkillProbeError } from "../Errors.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

/** Bounds the cache across instances x workspaces; oldest entry evicted. */
const SKILL_CACHE_CAPACITY = 64;

const KEY_SEPARATOR = String.fromCharCode(0);

export interface ProviderSkillDiscoveryShape {
  readonly listSkills: (
    input: ServerProviderSkillsInput,
  ) => Effect.Effect<ServerProviderSkillsResult>;
}

export class ProviderSkillDiscovery extends Context.Service<
  ProviderSkillDiscovery,
  ProviderSkillDiscoveryShape
>()("t3/provider/Services/ProviderSkillDiscovery") {}

type SkillProbe = (
  cwd: string,
) => Effect.Effect<ReadonlyArray<ServerProviderSkill>, ProviderSkillProbeError>;

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const revalidateScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(revalidateScope, Exit.void));

  const cache = new Map<string, ReadonlyArray<ServerProviderSkill>>();
  const inflight = new Map<string, Deferred.Deferred<ReadonlyArray<ServerProviderSkill>>>();

  const rememberSkills = (key: string, skills: ReadonlyArray<ServerProviderSkill>) => {
    cache.delete(key);
    cache.set(key, skills);
    while (cache.size > SKILL_CACHE_CAPACITY) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  };

  const runProbe = (
    key: string,
    deferred: Deferred.Deferred<ReadonlyArray<ServerProviderSkill>>,
    discover: SkillProbe,
    cwd: string,
  ) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(discover(cwd));
      if (Exit.isSuccess(exit)) {
        rememberSkills(key, exit.value);
      } else {
        yield* Effect.logWarning("Provider skill probe failed; keeping last inventory.", {
          key,
          errorTag: causeErrorTag(exit.cause),
        });
      }
      yield* Deferred.succeed(deferred, Exit.isSuccess(exit) ? exit.value : (cache.get(key) ?? []));
    }).pipe(
      // Cleanup on ANY exit, interruption included: drop the inflight
      // entry and unblock waiters with the last good inventory. A
      // completed deferred ignores the second succeed.
      Effect.onExit(() =>
        Effect.gen(function* () {
          inflight.delete(key);
          yield* Deferred.succeed(deferred, cache.get(key) ?? []);
        }),
      ),
    );

  /**
   * Ensure one probe is in flight for `key` and return its deferred.
   * The probe runs detached in the service scope so an interrupted
   * request (picker closed, client gone) can never orphan the inflight
   * entry and wedge the key.
   */
  const ensureProbe = (
    key: string,
    discover: SkillProbe,
    cwd: string,
  ): Effect.Effect<Deferred.Deferred<ReadonlyArray<ServerProviderSkill>>> =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<ReadonlyArray<ServerProviderSkill>>();
      // No yield points between the check and the set: the first fiber
      // to reach here wins the key, later ones join its deferred.
      const existing = inflight.get(key);
      if (existing) {
        return existing;
      }
      inflight.set(key, deferred);
      yield* runProbe(key, deferred, discover, cwd).pipe(Effect.forkIn(revalidateScope));
      return deferred;
    });

  const listSkills = (
    input: ServerProviderSkillsInput,
  ): Effect.Effect<ServerProviderSkillsResult> =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(input.instanceId);
      if (instance === undefined) {
        return { skills: [] };
      }
      const discover = instance.discoverSkills;
      const workspaceCwd = input.cwd;
      if (workspaceCwd === null || discover === undefined) {
        const snapshot = yield* instance.snapshot.getSnapshot;
        return { skills: snapshot.skills };
      }

      const cwd = yield* fileSystem
        .realPath(workspaceCwd)
        .pipe(Effect.orElseSucceed(() => workspaceCwd));
      const key = `${input.instanceId}${KEY_SEPARATOR}${cwd}`;
      const cached = cache.get(key);
      const deferred = yield* ensureProbe(key, discover, cwd);
      if (cached !== undefined) {
        return { skills: cached };
      }
      return { skills: yield* Deferred.await(deferred) };
    });

  return { listSkills } satisfies ProviderSkillDiscoveryShape;
});

export const layer = Layer.effect(ProviderSkillDiscovery, make);
