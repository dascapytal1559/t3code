// Fork: SSH launch runs the fork server (FORK_FEATURES.md). An explicit
// package spec must win even when a global `t3` binary is installed remotely.
import { assert, describe, it } from "@effect/vitest";

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

describe("ssh tunnel scripts (fork)", () => {
  it("runs an explicit package spec before a globally installed t3", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "/home/ubuntu/.t3/fork/t3-fork.tgz",
      preferPackageSpec: true,
    });

    assert.include(script, "T3_PREFER_PACKAGE_SPEC=1");
    assert.isBelow(
      script.indexOf('if [ "$T3_PREFER_PACKAGE_SPEC" = "1" ]'),
      script.indexOf("if command -v t3"),
    );
    assert.include(
      script,
      "exec npx --yes --package '/home/ubuntu/.t3/fork/t3-fork.tgz' -- t3 \"$@\"",
    );
  });

  it("keeps the global binary first without an explicit spec", () => {
    const script = buildRemoteT3RunnerScript({ packageSpec: "t3@latest" });

    assert.include(script, "T3_PREFER_PACKAGE_SPEC=0");
    assert.include(script, 'exec t3 "$@"');
  });
});
