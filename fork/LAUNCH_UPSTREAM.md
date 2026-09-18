# Launch upstream on this Mac

The upstream checkout is `/Users/zerongwang/Projects/t3code-upstream-test`,
pinned to `pingdotgg/t3code` commit `50ff4c371eab927a9650c114975241999f4cd7b1`.
Its source is unmodified.

## Existing test app

```sh
"/Users/zerongwang/.local/share/t3code-upstream-test/Start Upstream T3.command"
```

This launches **T3 Code (Alpha)** with production-built assets in unpackaged
Electron. It is not the official distributed release.

- Copied history: `<checkout>/.t3/userdata`.
- Separate Electron profile: `<checkout>/.t3/electron-profile`.
- Launcher, process record, and log: `~/.local/share/t3code-upstream-test/`.
- Actual backend port: `<checkout>/.t3/userdata/server-runtime.json`.

The installed fork remains `/Applications/T3 Code (Fork).app` and uses
`~/.t3/userdata`. Both copies still reference the original project directories.

## Build a packaged upstream app

```sh
cd /Users/zerongwang/Projects/t3code-upstream-test
DEVELOPER_DIR=/Library/Developer/CommandLineTools vp run dist:desktop:artifact \
  --platform mac --target zip --arch arm64 \
  --output-dir /Users/zerongwang/.local/share/t3code-upstream-test/packaged \
  --keep-stage
```

The explicit developer directory uses the working standalone Command Line
Tools on this Mac.

**Isolation caveat:** `T3CODE_HOME` separates the database but does not isolate
upstream's macOS Electron profile. The existing `launch.cjs` redirects that
profile for the unpackaged launch. A packaged launch needs equivalent isolation
before opening it alongside the fork. Verify the extracted app's code signature
before installation.
