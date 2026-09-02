// Fork: deterministic web-client cache headers (FORK_FEATURES.md).
import { describe, expect, it } from "@effect/vitest";

import { staticResponseCacheControl } from "./http.ts";

describe("staticResponseCacheControl", () => {
  it("marks content-hashed assets immutable", () => {
    expect(staticResponseCacheControl("assets/index-NfwA1S9h.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(staticResponseCacheControl("assets\\index-NfwA1S9h.js")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("forces revalidation for everything else", () => {
    expect(staticResponseCacheControl("index.html")).toBe("no-cache");
    expect(staticResponseCacheControl("favicon.ico")).toBe("no-cache");
    // A non-hashed path merely containing the segment is not immutable.
    expect(staticResponseCacheControl("nested/assets/file.js")).toBe("no-cache");
  });
});
