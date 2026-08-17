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

export const ProviderSkillDiscoveryLive: Layer.Layer<
  ProviderSkillDiscovery,
  never,
  ProviderInstanceRegistry | FileSystem.FileSystem
> = Layer.effect(
  ProviderSkillDiscovery,
  Effect.gen(function* () {
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

    /**
     * Run one probe for `key`, coalescing with any probe already in
     * flight. A failed probe keeps the last good inventory rather than
     * replacing it with an empty list.
     */
    const revalidate = (
      key: string,
      discover: (cwd: string) => Effect.Effect<ReadonlyArray<ServerProviderSkill>>,
      cwd: string,
    ): Effect.Effect<ReadonlyArray<ServerProviderSkill>> =>
      Effect.gen(function* () {
        const existing = inflight.get(key);
        if (existing) {
          return yield* Deferred.await(existing);
        }
        const deferred = yield* Deferred.make<ReadonlyArray<ServerProviderSkill>>();
        inflight.set(key, deferred);
        const exit = yield* Effect.exit(discover(cwd));
        inflight.delete(key);
        if (Exit.isSuccess(exit)) {
          rememberSkills(key, exit.value);
        } else {
          yield* Effect.logWarning("Provider skill probe failed; keeping last inventory.", {
            key,
          });
        }
        const skills = Exit.isSuccess(exit) ? exit.value : (cache.get(key) ?? []);
        yield* Deferred.succeed(deferred, skills);
        return skills;
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
        if (cached !== undefined) {
          if (!inflight.has(key)) {
            yield* revalidate(key, discover, cwd).pipe(
              Effect.asVoid,
              Effect.forkIn(revalidateScope),
            );
          }
          return { skills: cached };
        }
        return { skills: yield* revalidate(key, discover, cwd) };
      });

    return { listSkills } satisfies ProviderSkillDiscoveryShape;
  }),
) as Layer.Layer<ProviderSkillDiscovery, never, ProviderInstanceRegistry | FileSystem.FileSystem>;
