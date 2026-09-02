// Fork: SSH launch runs the fork server (FORK_FEATURES.md).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseRemoteT3CliPackageSpecOverride, resolveRemoteT3CliPackageSpec } from "./command.ts";

describe("ssh command (fork)", () => {
  it.effect("prefers an override spec over the release channel", () =>
    Effect.sync(() => {
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
          overrideSpec: "/home/ubuntu/.t3/fork/t3-fork.tgz",
        }),
        "/home/ubuntu/.t3/fork/t3-fork.tgz",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
          overrideSpec: "   ",
        }),
        "t3@0.0.17",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
          overrideSpec: null,
        }),
        "t3@0.0.17",
      );
    }),
  );

  it.effect("parses the package spec override file contents", () =>
    Effect.sync(() => {
      assert.equal(
        parseRemoteT3CliPackageSpecOverride(
          ["# fork server tarball", "", "  /home/ubuntu/.t3/fork/t3-fork.tgz  ", "ignored"].join(
            "\n",
          ),
        ),
        "/home/ubuntu/.t3/fork/t3-fork.tgz",
      );
      assert.equal(parseRemoteT3CliPackageSpecOverride("# only comments\n\n"), null);
      assert.equal(parseRemoteT3CliPackageSpecOverride(""), null);
    }),
  );
});
