import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { ProviderSkillDiscovery, ProviderSkillDiscoveryLive } from "./ProviderSkillDiscovery.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok");

const BASELINE_SKILL: ServerProviderSkill = {
  name: "baseline",
  path: "/home/user/.grok/skills/baseline/SKILL.md",
  enabled: true,
  scope: "user",
};

const PROJECT_SKILL: ServerProviderSkill = {
  name: "project-skill",
  path: "/repo/.grok/skills/project-skill/SKILL.md",
  enabled: true,
  scope: "project",
};

const makeInstance = (input: {
  readonly instanceId: string;
  readonly discoverSkills?: ProviderInstance["discoverSkills"];
}): ProviderInstance => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driverKind: DRIVER_KIND,
  continuationIdentity: {
    driverKind: DRIVER_KIND,
    continuationKey: `${DRIVER_KIND}:instance:${input.instanceId}`,
  },
  displayName: undefined,
  enabled: true,
  snapshot: {
    maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    }),
    getSnapshot: Effect.succeed({ skills: [BASELINE_SKILL] } as unknown as ServerProvider),
    refresh: Effect.succeed({} as unknown as ServerProvider),
    streamChanges: Stream.empty,
  },
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as unknown as TextGeneration.TextGeneration["Service"],
  ...(input.discoverSkills ? { discoverSkills: input.discoverSkills } : {}),
});

const makeLayer = (instances: ReadonlyArray<ProviderInstance>) =>
  Layer.mergeAll(
    Layer.provide(
      ProviderSkillDiscoveryLive,
      Layer.mergeAll(
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: (instanceId) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
          listInstances: Effect.succeed(instances),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
            PubSub.subscribe(pubsub),
          ),
        }),
        NodeServices.layer,
      ),
    ),
    NodeServices.layer,
  );

describe("ProviderSkillDiscovery", () => {
  it.effect("returns an empty inventory for an unknown instance", () =>
    Effect.gen(function* () {
      const discovery = yield* ProviderSkillDiscovery;
      const result = yield* discovery.listSkills({
        instanceId: ProviderInstanceId.make("missing"),
        cwd: "/repo",
      });
      expect(result.skills).toEqual([]);
    }).pipe(Effect.provide(makeLayer([]))),
  );

  it.effect("serves the snapshot baseline for a null cwd", () =>
    Effect.gen(function* () {
      const discovery = yield* ProviderSkillDiscovery;
      const result = yield* discovery.listSkills({
        instanceId: ProviderInstanceId.make("grok"),
        cwd: null,
      });
      expect(result.skills).toEqual([BASELINE_SKILL]);
    }).pipe(
      Effect.provide(
        makeLayer([
          makeInstance({
            instanceId: "grok",
            discoverSkills: () => Effect.succeed([PROJECT_SKILL]),
          }),
        ]),
      ),
    ),
  );

  it.effect("serves the snapshot baseline when the driver has no discovery", () =>
    Effect.gen(function* () {
      const discovery = yield* ProviderSkillDiscovery;
      const result = yield* discovery.listSkills({
        instanceId: ProviderInstanceId.make("cursor-like"),
        cwd: "/repo",
      });
      expect(result.skills).toEqual([BASELINE_SKILL]);
    }).pipe(Effect.provide(makeLayer([makeInstance({ instanceId: "cursor-like" })]))),
  );

  it.effect("waits for the first probe, then serves cached while revalidating", () => {
    const state = { probes: 0, secondProbeDone: undefined as Deferred.Deferred<void> | undefined };
    const instance = makeInstance({
      instanceId: "grok",
      discoverSkills: () =>
        Effect.suspend(() => {
          state.probes += 1;
          return state.probes >= 2 && state.secondProbeDone
            ? Deferred.succeed(state.secondProbeDone, undefined).pipe(Effect.as([PROJECT_SKILL]))
            : Effect.succeed([PROJECT_SKILL]);
        }),
    });
    return Effect.gen(function* () {
      state.secondProbeDone = yield* Deferred.make<void>();
      const discovery = yield* ProviderSkillDiscovery;
      const instanceId = ProviderInstanceId.make("grok");

      const cold = yield* discovery.listSkills({ instanceId, cwd: "/repo" });
      expect(cold.skills).toEqual([PROJECT_SKILL]);
      expect(state.probes).toBe(1);

      // The warm hit answers from cache and forks one background probe.
      const warm = yield* discovery.listSkills({ instanceId, cwd: "/repo" });
      expect(warm.skills).toEqual([PROJECT_SKILL]);
      yield* Deferred.await(state.secondProbeDone);
      expect(state.probes).toBe(2);
    }).pipe(Effect.provide(makeLayer([instance])));
  });

  it.effect("keeps the last good inventory when a revalidation dies", () => {
    const state = { probes: 0, secondProbeDone: undefined as Deferred.Deferred<void> | undefined };
    const instance = makeInstance({
      instanceId: "grok",
      discoverSkills: () =>
        Effect.suspend(() => {
          state.probes += 1;
          if (state.probes === 1 || !state.secondProbeDone) {
            return Effect.succeed([PROJECT_SKILL]);
          }
          return Deferred.succeed(state.secondProbeDone, undefined).pipe(
            Effect.flatMap(() => Effect.die("probe crashed")),
          );
        }),
    });
    return Effect.gen(function* () {
      state.secondProbeDone = yield* Deferred.make<void>();
      const discovery = yield* ProviderSkillDiscovery;
      const instanceId = ProviderInstanceId.make("grok");

      const cold = yield* discovery.listSkills({ instanceId, cwd: "/repo" });
      expect(cold.skills).toEqual([PROJECT_SKILL]);

      const warm = yield* discovery.listSkills({ instanceId, cwd: "/repo" });
      expect(warm.skills).toEqual([PROJECT_SKILL]);
      yield* Deferred.await(state.secondProbeDone);

      // The dead probe must not have evicted the last good inventory.
      const afterFailure = yield* discovery.listSkills({ instanceId, cwd: "/repo" });
      expect(afterFailure.skills).toEqual([PROJECT_SKILL]);
    }).pipe(Effect.provide(makeLayer([instance])));
  });

  it.effect("evicts the oldest key once the cache bound is exceeded", () => {
    const probedCwds: string[] = [];
    const instance = makeInstance({
      instanceId: "grok",
      discoverSkills: (cwd) =>
        Effect.sync(() => {
          probedCwds.push(cwd);
          return [PROJECT_SKILL];
        }),
    });
    return Effect.gen(function* () {
      const discovery = yield* ProviderSkillDiscovery;
      const instanceId = ProviderInstanceId.make("grok");

      // Fill one entry past the 64-entry bound, evicting the first key.
      for (let index = 0; index <= 64; index += 1) {
        yield* discovery.listSkills({ instanceId, cwd: `/repo-${index}` });
      }
      const probesBefore = probedCwds.length;

      // The evicted key is cold again: this request waits on a fresh probe
      // rather than answering from cache.
      const refetched = yield* discovery.listSkills({ instanceId, cwd: "/repo-0" });
      expect(refetched.skills).toEqual([PROJECT_SKILL]);
      expect(probedCwds.length).toBeGreaterThan(probesBefore);
      expect(probedCwds.at(-1)).toBe("/repo-0");
    }).pipe(Effect.provide(makeLayer([instance])));
  });

  it.effect("coalesces concurrent cold requests onto one probe", () => {
    const state = { probes: 0, release: undefined as Deferred.Deferred<void> | undefined };
    const instance = makeInstance({
      instanceId: "grok",
      discoverSkills: () =>
        Effect.suspend(() => {
          state.probes += 1;
          return state.release
            ? Deferred.await(state.release).pipe(Effect.as([PROJECT_SKILL]))
            : Effect.succeed([PROJECT_SKILL]);
        }),
    });
    return Effect.gen(function* () {
      state.release = yield* Deferred.make<void>();
      const discovery = yield* ProviderSkillDiscovery;
      const instanceId = ProviderInstanceId.make("grok");

      const fiberA = yield* discovery
        .listSkills({ instanceId, cwd: "/repo" })
        .pipe(Effect.forkChild);
      const fiberB = yield* discovery
        .listSkills({ instanceId, cwd: "/repo" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(state.release, undefined);

      const first = yield* Fiber.join(fiberA);
      const second = yield* Fiber.join(fiberB);
      expect(first.skills).toEqual([PROJECT_SKILL]);
      expect(second.skills).toEqual([PROJECT_SKILL]);
      expect(state.probes).toBe(1);
    }).pipe(Effect.provide(makeLayer([instance])));
  });
});
