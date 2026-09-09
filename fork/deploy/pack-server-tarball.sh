#!/bin/bash
# Builds apps/server (bundle + web client) and packs the fork server as a
# self-contained npm tarball. package.json is temporarily rewritten because
# npm cannot read vp's `catalog:` dependency specs, and pnpm-style override
# selectors are dropped (npm rejects their syntax and ignores a dependency's
# overrides on install anyway). Restores package.json even on failure.
# Prints the absolute tarball path as the last stdout line.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SERVER_DIR="$REPO/apps/server"
cd "$SERVER_DIR"

vp run build >&2

cp package.json package.json.orig
trap 'mv package.json.orig package.json' EXIT

node --input-type=module -e '
import fs from "node:fs";
import { parse } from "yaml";
const ws = parse(fs.readFileSync("../../pnpm-workspace.yaml", "utf8"));
const catalog = ws.catalog ?? {};
const resolve = (deps) => Object.fromEntries(Object.entries(deps ?? {}).map(([name, spec]) => {
  if (spec !== "catalog:") return [name, spec];
  if (!catalog[name]) throw new Error("no catalog entry for " + name);
  return [name, catalog[name]];
}));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const out = {
  name: pkg.name, repository: pkg.repository, bin: pkg.bin, type: pkg.type,
  version: pkg.version, engines: pkg.engines, files: pkg.files,
  dependencies: resolve(pkg.dependencies),
};
fs.writeFileSync("package.json", JSON.stringify(out, null, 2) + "\n");
'

TARBALL="$(npm pack --silent | tail -1)"
echo "$SERVER_DIR/$TARBALL"
