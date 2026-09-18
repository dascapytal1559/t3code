import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds on the latest update channel", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(resolveDefaultDesktopUpdateChannel("1.2.3-foo-nightly.20260911.1")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("1.2.3")).toBe("latest");
  });
});
