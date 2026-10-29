import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isUpstreamReleaseDismissed,
  selectUpstreamRelease,
  shouldCheckUpstreamReleases,
  type UpstreamReleaseFeed,
  upstreamReleaseFeedAtom,
} from "./upstreamRelease";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const feed = (
  latestTag: string,
  tags: ReadonlyArray<string> = [latestTag],
): UpstreamReleaseFeed => ({
  latest: { tag_name: latestTag, draft: false, prerelease: false },
  tags,
});

function respondWith(latestTag: string, tags: ReadonlyArray<string>) {
  fetchMock.mockImplementation(async (input) => {
    const url = new Request(input).url;
    if (url.endsWith("/releases/latest")) {
      return Response.json({ tag_name: latestTag, draft: false, prerelease: false, body: "…" });
    }
    return Response.json(tags.map((name) => ({ name, commit: { sha: "abc" } })));
  });
}

async function settled(registry: AtomRegistry.AtomRegistry) {
  await vi.waitFor(() => {
    const result = registry.get(upstreamReleaseFeedAtom);
    expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
  });
  return registry.get(upstreamReleaseFeedAtom);
}

describe("selectUpstreamRelease", () => {
  it.each([
    { name: "newer stable release", latest: "v0.1.4", tags: [], expected: "0.1.4" },
    { name: "same release", latest: "v0.1.3", tags: [], expected: null },
    { name: "older release", latest: "v0.1.2", tags: [], expected: null },
    { name: "nightly as latest", latest: "v0.1.4-nightly.20261029.3853", tags: [], expected: null },
  ])("$name", ({ latest, tags, expected }) => {
    expect(selectUpstreamRelease(feed(latest, tags), "0.1.3")?.version ?? null).toBe(expected);
  });

  it("skips a release GitHub marks as a prerelease or draft", () => {
    const base = feed("v0.1.4");
    expect(
      selectUpstreamRelease({ ...base, latest: { ...base.latest, prerelease: true } }, "0.1.3"),
    ).toBeNull();
    expect(
      selectUpstreamRelease({ ...base, latest: { ...base.latest, draft: true } }, "0.1.3"),
    ).toBeNull();
  });

  it("counts every stable release past this build, ignoring nightlies and previews", () => {
    const release = selectUpstreamRelease(
      feed("v0.2.0", [
        "v0.2.1-nightly.20261101.1",
        "v0.2.0",
        "v0.2.0-preview.20261031.1",
        "v0.1.5",
        "v0.1.4",
        "v0.1.4-nightly.20261029.3853",
        "v0.1.3",
        "v0.1.2",
      ]),
      "0.1.3",
    );
    expect(release).toEqual({ version: "0.2.0", currentVersion: "0.1.3", releaseCount: 3 });
  });
});

describe("shouldCheckUpstreamReleases", () => {
  it("checks only when no update feed is configured and the desktop updater is off", () => {
    expect(shouldCheckUpstreamReleases({ status: "disabled" }, "")).toBe(true);
    expect(shouldCheckUpstreamReleases({ status: "disabled" }, "pingdotgg/t3code")).toBe(false);
    expect(shouldCheckUpstreamReleases({ status: "idle" }, "")).toBe(false);
    expect(shouldCheckUpstreamReleases(null, "")).toBe(false);
  });
});

describe("isUpstreamReleaseDismissed", () => {
  it("hides the dismissed release until a newer one ships", () => {
    expect(isUpstreamReleaseDismissed({ version: "0.1.4" }, null)).toBe(false);
    expect(isUpstreamReleaseDismissed({ version: "0.1.4" }, "0.1.4")).toBe(true);
    expect(isUpstreamReleaseDismissed({ version: "0.1.5" }, "0.1.4")).toBe(false);
  });
});

describe("upstreamReleaseFeedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the last good feed when a later check fails", async () => {
    respondWith("v0.1.4", ["v0.1.4-nightly.20261029.3853", "v0.1.4", "v0.1.3"]);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(upstreamReleaseFeedAtom);
    try {
      const first = await settled(registry);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
      expect(request.headers.get("traceparent")).toBeNull();
      const good = AsyncResult.getOrElse(first, () => null);
      expect(selectUpstreamRelease(good, "0.1.3")?.version).toBe("0.1.4");

      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      registry.refresh(upstreamReleaseFeedAtom);
      const second = await settled(registry);

      expect(fetchMock).toHaveBeenCalled();
      expect(AsyncResult.isFailure(second)).toBe(true);
      expect(AsyncResult.getOrElse(second, () => null)).toEqual(good);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
