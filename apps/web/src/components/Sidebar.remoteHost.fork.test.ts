// Fork: Remote host on thread cards (FORK_FEATURES.md).
import { describe, expect, it } from "vite-plus/test";

import { isRemoteThreadEnvironment } from "./Sidebar.logic";

describe("isRemoteThreadEnvironment", () => {
  it("does not mark the primary environment", () => {
    expect(
      isRemoteThreadEnvironment({
        threadEnvironmentId: "local",
        primaryEnvironmentId: "local",
        desktopLocalEnvironmentIds: new Set(),
      }),
    ).toBe(false);
  });

  it("does not mark a desktop-local environment reached another way", () => {
    expect(
      isRemoteThreadEnvironment({
        threadEnvironmentId: "local-via-url",
        primaryEnvironmentId: "local",
        desktopLocalEnvironmentIds: new Set(["local-via-url"]),
      }),
    ).toBe(false);
  });

  it("marks an environment on another machine", () => {
    expect(
      isRemoteThreadEnvironment({
        threadEnvironmentId: "zdata",
        primaryEnvironmentId: "local",
        desktopLocalEnvironmentIds: new Set(["local"]),
      }),
    ).toBe(true);
  });

  it("marks every non-desktop-local environment when there is no primary (hosted app)", () => {
    expect(
      isRemoteThreadEnvironment({
        threadEnvironmentId: "zdata",
        primaryEnvironmentId: null,
        desktopLocalEnvironmentIds: new Set(),
      }),
    ).toBe(true);
  });
});
