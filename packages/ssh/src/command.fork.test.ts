// Fork: SSH launch runs the fork server (FORK_FEATURES.md).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseRemoteT3CliPackageSpecOverride } from "./command.ts";

describe("ssh command (fork)", () => {
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
