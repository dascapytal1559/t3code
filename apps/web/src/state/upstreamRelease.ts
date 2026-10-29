import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import { useLocalStorage } from "../hooks/useLocalStorage";

export const UPSTREAM_RELEASE_REPOSITORY = "pingdotgg/t3code";
const UPSTREAM_RELEASE_API = `https://api.github.com/repos/${UPSTREAM_RELEASE_REPOSITORY}`;
const DISMISSED_VERSION_STORAGE_KEY = "t3code:upstream-release-dismissed-version:v1";
const STABLE_RELEASE_TAG = /^v\d+\.\d+\.\d+$/u;
const DismissedVersionSchema = Schema.NullOr(Schema.String);

const LatestReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});
const TagsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));

export interface UpstreamReleaseFeed {
  readonly latest: typeof LatestReleaseSchema.Type;
  readonly tags: ReadonlyArray<string>;
}

export interface UpstreamRelease {
  readonly version: string;
  readonly currentVersion: string;
  /** Stable releases newer than this build, the newest included. */
  readonly releaseCount: number;
}

/**
 * Builds without an update feed (this fork) never hear about upstream releases. Builds
 * with a feed keep the official updater and never check.
 */
export function shouldCheckUpstreamReleases(
  state: Pick<DesktopUpdateState, "status"> | null,
  updateRepository: string | undefined,
): boolean {
  return !updateRepository?.trim() && state?.status === "disabled";
}

function stableVersion(tag: string): string | null {
  return STABLE_RELEASE_TAG.test(tag) ? tag.slice(1) : null;
}

export function selectUpstreamRelease(
  feed: UpstreamReleaseFeed | null,
  currentVersion: string,
): UpstreamRelease | null {
  if (!feed || feed.latest.draft || feed.latest.prerelease) return null;
  const version = stableVersion(feed.latest.tag_name);
  if (!version || compareSemverVersions(version, currentVersion) <= 0) return null;
  const between = new Set([version]);
  for (const tag of feed.tags) {
    const tagVersion = stableVersion(tag);
    if (
      tagVersion &&
      compareSemverVersions(tagVersion, currentVersion) > 0 &&
      compareSemverVersions(tagVersion, version) < 0
    ) {
      between.add(tagVersion);
    }
  }
  return { version, currentVersion, releaseCount: between.size };
}

export function isUpstreamReleaseDismissed(
  release: Pick<UpstreamRelease, "version">,
  dismissedVersion: string | null,
): boolean {
  return dismissedVersion !== null && compareSemverVersions(release.version, dismissedVersion) <= 0;
}

const getJson = <S extends Schema.Top>(path: string, schema: S) =>
  HttpClient.get(`${UPSTREAM_RELEASE_API}${path}`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  );

/** A failed refresh keeps the last good feed: `AsyncResult.getOrElse` reads `previousSuccess`. */
export const upstreamReleaseFeedAtom = Atom.make(
  Effect.all(
    {
      latest: getJson("/releases/latest", LatestReleaseSchema),
      // The first page reaches back past the last stable release; nightlies fill the rest.
      tags: getJson("/tags?per_page=100", TagsSchema).pipe(
        Effect.map((tags) => tags.map((tag) => tag.name)),
      ),
    },
    { concurrency: "unbounded" },
  ).pipe(
    // Tracing headers would make the browser send a CORS preflight.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(FetchHttpClient.layer),
  ),
).pipe(
  // GitHub allows 60 unauthenticated requests an hour; each check spends two.
  Atom.withRefresh("6 hours"),
  Atom.keepAlive,
  Atom.withLabel("upstream-release-feed"),
);

type FeedAtom = Atom.Atom<AsyncResult.AsyncResult<UpstreamReleaseFeed, unknown>>;

const NO_FEED_ATOM: FeedAtom = Atom.make(AsyncResult.initial()).pipe(
  Atom.withLabel("upstream-release-feed:off"),
);

export interface UpstreamReleaseNotice {
  readonly release: UpstreamRelease;
  readonly dismiss: () => void;
}

export function useUpstreamReleaseNotice(
  state: DesktopUpdateState | null,
): UpstreamReleaseNotice | null {
  const enabled = shouldCheckUpstreamReleases(
    state,
    import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
  );
  const feedAtom: FeedAtom = enabled ? upstreamReleaseFeedAtom : NO_FEED_ATOM;
  const result = useAtomValue(feedAtom);
  const [dismissedVersion, setDismissedVersion] = useLocalStorage(
    DISMISSED_VERSION_STORAGE_KEY,
    null,
    DismissedVersionSchema,
  );
  if (!enabled || !state) return null;
  const release = selectUpstreamRelease(
    AsyncResult.getOrElse(result, () => null),
    state.currentVersion,
  );
  if (!release || isUpstreamReleaseDismissed(release, dismissedVersion)) return null;
  return { release, dismiss: () => setDismissedVersion(release.version) };
}
