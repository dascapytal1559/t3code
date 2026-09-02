// Fork: desktop runs a swappable server payload; SSH launch runs the fork
// server (FORK_FEATURES.md).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  desktopServerRootOverridePath,
  readDesktopServerRootOverride,
  readSshPackageSpecOverride,
} from "./DesktopForkOverrides.ts";

const makeHomeDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-desktop-fork-overrides-" });
});

const writeFile = Effect.fn(function* (absolutePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

it.layer(NodeServices.layer)("DesktopForkOverrides", (it) => {
  describe("readDesktopServerRootOverride", () => {
    it.effect("returns null when no payload is staged", () =>
      Effect.gen(function* () {
        const home = yield* makeHomeDirectory;
        assert.isNull(readDesktopServerRootOverride(home));
      }),
    );

    it.effect("returns the unresolved symlink path when it holds a server entry", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHomeDirectory;
        const build = `${home}/.t3/fork/builds/abc123`;
        yield* writeFile(`${build}/apps/server/dist/bin.mjs`, "// server\n");
        yield* fileSystem.symlink(build, desktopServerRootOverridePath(home));

        // The symlink, not its target: the supervisor respawns from this path,
        // so retargeting the link is enough to pick up the next build.
        assert.equal(readDesktopServerRootOverride(home), `${home}/.t3/fork/current`);
      }),
    );

    it.effect("ignores a staged directory without the server entry", () =>
      Effect.gen(function* () {
        const home = yield* makeHomeDirectory;
        yield* writeFile(`${desktopServerRootOverridePath(home)}/package.json`, "{}\n");

        assert.isNull(readDesktopServerRootOverride(home));
      }),
    );
  });

  describe("readSshPackageSpecOverride", () => {
    it.effect("returns null when the override file is missing", () =>
      Effect.gen(function* () {
        const home = yield* makeHomeDirectory;
        assert.isNull(yield* readSshPackageSpecOverride(home));
      }),
    );

    it.effect("returns the first non-empty non-comment line", () =>
      Effect.gen(function* () {
        const home = yield* makeHomeDirectory;
        yield* writeFile(
          `${home}/.t3/fork/ssh-t3-package-spec`,
          "# fork server tarball\n\n  /home/ubuntu/.t3/fork/t3-fork.tgz  \nignored\n",
        );

        assert.equal(yield* readSshPackageSpecOverride(home), "/home/ubuntu/.t3/fork/t3-fork.tgz");
      }),
    );

    it.effect("treats a comment-only file as no override", () =>
      Effect.gen(function* () {
        const home = yield* makeHomeDirectory;
        yield* writeFile(`${home}/.t3/fork/ssh-t3-package-spec`, "# nothing yet\n\n");

        assert.isNull(yield* readSshPackageSpecOverride(home));
      }),
    );
  });
});
