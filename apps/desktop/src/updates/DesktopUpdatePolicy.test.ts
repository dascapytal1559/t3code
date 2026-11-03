import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";

describe("DesktopUpdatePolicy", () => {
  it.effect("keeps a managed policy's limits but never its update feed", () =>
    Effect.gen(function* () {
      const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
      assert.deepEqual(policy, {
        mode: "auto",
        feedUrl: undefined,
        allowNightly: false,
        message: "Example Corp manages T3 Code updates.",
      });
    }).pipe(
      Effect.provide(
        DesktopUpdatePolicy.layer.pipe(
          Layer.provide(
            DesktopManagedPolicy.layerTest({
              schemaVersion: 1,
              organization: "Example Corp",
              limits: {
                updates: {
                  mode: "auto",
                  feedUrl: "https://updates.example.com/t3code",
                  allowNightly: false,
                },
              },
            }),
          ),
        ),
      ),
    ),
  );
});
