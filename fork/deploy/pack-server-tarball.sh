#!/bin/bash
# Builds apps/server (bundle + web client) and packs the fork server as a
# self-contained npm tarball, assembled in a scratch directory so the checkout
# is never rewritten. Two pnpm-only mechanisms are translated for npm: vp's
# `catalog:` specs are resolved from pnpm-workspace.yaml, and pnpm patches,
# which an npm install never applies, ship by copying the patched package out
# of the pnpm store as a bundled dependency. Prints the absolute tarball path
# as the last stdout line.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SERVER_DIR="$REPO/apps/server"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

(cd "$SERVER_DIR" && vp run build >&2)
cp -R "$SERVER_DIR/dist" "$STAGE/dist"

# Runs from apps/server so `yaml` resolves; the stage dir comes in as argv.
(cd "$SERVER_DIR" && node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const stage = process.argv.at(-1);
const ws = parse(fs.readFileSync("../../pnpm-workspace.yaml", "utf8"));
const catalog = ws.catalog ?? {};
const patched = ws.patchedDependencies ?? {};
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const dependencies = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => {
  if (spec !== "catalog:") return [name, spec];
  if (!catalog[name]) throw new Error("no catalog entry for " + name);
  return [name, catalog[name]];
}));

// Every patched runtime dependency needs a packing decision, recorded here so
// a new upstream patch fails the pack instead of the server on a remote host.
// Bundle leaf packages. Never bundle one that other registry-installed
// packages peer-depend on: the npx install on the remotes nests bundled
// packages under t3/node_modules, so a peer would pull a second copy.
const BUNDLED = new Set([
  // Adds the `require` export condition WorkspaceSearchIndex loads it through.
  "@ff-labs/fff-node",
]);
const UNPATCHED = new Set([
  // @effect/platform-node peer-depends on it, and the patch only touches
  // McpServer, RpcClient request hooks, and mobile Headers, none of which the
  // server exercises. Deployed payloads have always run the registry build.
  "effect",
]);
const installedVersion = (name) =>
  JSON.parse(fs.readFileSync(path.join("node_modules", name, "package.json"), "utf8")).version;
const patchedRuntime = Object.keys(dependencies).filter(
  (name) => `${name}@${installedVersion(name)}` in patched,
);
const undecided = patchedRuntime.filter((name) => !BUNDLED.has(name) && !UNPATCHED.has(name));
if (undecided.length > 0) {
  throw new Error(
    "patched runtime dependencies without a packing decision: " + undecided.join(", ") +
    " (add to BUNDLED or UNPATCHED in pack-server-tarball.sh)",
  );
}
const bundleDependencies = patchedRuntime.filter((name) => BUNDLED.has(name));
const optionalDependencies = {};
// npm takes a bundled package as a complete subtree and fetches nothing for
// it, so the dependencies of each bundled package are declared on the tarball
// and install beside it, where the Node lookup walks up to them.
const hoist = (target, name, spec) => {
  if (target[name] !== undefined && target[name] !== spec) {
    throw new Error(`${name} wanted as ${target[name]} and ${spec}; cannot hoist`);
  }
  target[name] = spec;
};
for (const name of bundleDependencies) {
  const source = fs.realpathSync(path.join("node_modules", name));
  // The store directory holds the package alone; its dependencies are pnpm
  // siblings, not children.
  fs.cpSync(source, path.join(stage, "node_modules", name), {
    recursive: true,
    filter: (entry) => path.basename(entry) !== "node_modules",
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) hoist(dependencies, dep, spec);
  for (const [dep, spec] of Object.entries(manifest.optionalDependencies ?? {})) hoist(optionalDependencies, dep, spec);
}
console.error("bundled patched dependencies: " + (bundleDependencies.join(", ") || "none"));

const out = {
  name: pkg.name, repository: pkg.repository, bin: pkg.bin, type: pkg.type,
  version: pkg.version, engines: pkg.engines, files: pkg.files,
  dependencies,
  ...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
  ...(bundleDependencies.length > 0 ? { bundleDependencies } : {}),
};
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(out, null, 2) + "\n");
' -- "$STAGE")

TARBALL="$(cd "$STAGE" && npm pack --silent | tail -1)"
mv "$STAGE/$TARBALL" "$SERVER_DIR/$TARBALL"
echo "$SERVER_DIR/$TARBALL"
