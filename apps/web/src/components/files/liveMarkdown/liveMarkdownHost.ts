import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import type { WorkspaceEntryCandidate } from "@t3tools/client-runtime/workspace-basename-lookup";
import type { AssetResource, ThreadId } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";

import { resolveProtocolRelativeMediaUrl } from "~/components/media/mediaContent";

import type { ImageSource } from "./previewConfig";

// What the editor's generic hooks mean in T3: where a file's images load from and
// what a link in it opens. Kept apart from the editor so it stays plain CodeMirror.

/** How an image written in a file under `baseDir` loads, by the rules the rendered view follows. */
export function imageSourceOf(source: string, baseDir: string): ImageSource {
  const kind = mediaKindFromPath(source);
  // Video and audio written as images play in the rendered view; here their text stands in.
  if (kind === "video" || kind === "audio") return { kind: "blocked" };
  const classified = classifyMarkdownImageSource(source, baseDir);
  if (classified._tag === "Direct") {
    return { kind: "url", url: resolveProtocolRelativeMediaUrl(classified.uri) };
  }
  if (classified._tag === "WorkspaceFile") {
    return {
      kind: "asset",
      key: `${classified.relative ? "relative" : "absolute"}:${classified.path}`,
    };
  }
  return { kind: "blocked" };
}

const EMBED_KEY = "embed:";

/** An Obsidian picture embed is asked for by name; `findImageEmbed` finds its file. */
export const imageEmbedSourceOf = (target: string): ImageSource => ({
  kind: "asset",
  key: `${EMBED_KEY}${target}`,
});

/** The embed an asset key from `imageEmbedSourceOf` names, or null for any other key. */
export const imageEmbedTargetOf = (key: string): string | null =>
  key.startsWith(EMBED_KEY) ? key.slice(EMBED_KEY.length) : null;

/** The asset key that signs a file `findImageEmbed` found. */
export const imageEmbedFileKey = (path: string) => `relative:${path}`;

export interface ImageEmbedLookup {
  /** Whether each path is a file, in order; null when that cannot be told. */
  readonly files: (paths: readonly string[]) => Promise<ReadonlyArray<boolean> | null>;
  /** Project files, relative to its root, that a search for `name` turns up. */
  readonly search: (name: string) => Promise<ReadonlyArray<WorkspaceEntryCandidate>>;
}

/**
 * The file `![[target]]` embeds from a note under `baseDir`, as Obsidian finds it:
 * the path from the note's folder, the bare name in that folder, the path from the
 * project root, then the shortest project path that ends in it. The project search
 * skips gitignored folders; the first three do not.
 */
export async function findImageEmbed(
  target: string,
  baseDir: string,
  cwd: string,
  lookup: ImageEmbedLookup,
): Promise<string | null> {
  const written = target.replaceAll("\\", "/");
  const name = written.slice(written.lastIndexOf("/") + 1);
  const candidates = [
    ...new Set([
      resolveWorkspaceFilePath(written, baseDir),
      resolveWorkspaceFilePath(name, baseDir),
      resolveWorkspaceFilePath(written, cwd),
    ]),
  ];
  const found = await lookup.files(candidates);
  if (found === null) return null;
  const literal = candidates.find((_, index) => found[index]);
  if (literal !== undefined) return literal;
  const suffix = written.toLowerCase();
  const [shortest] = (await lookup.search(name))
    .flatMap((entry) => (entry.kind === "file" ? [entry.path.replaceAll("\\", "/")] : []))
    .filter((path) => {
      const folded = path.toLowerCase();
      return folded === suffix || folded.endsWith(`/${suffix}`);
    })
    .toSorted((left, right) => left.length - right.length || left.localeCompare(right));
  return shortest === undefined ? null : resolveWorkspaceFilePath(shortest, cwd);
}

/** The host file behind an asset key from `imageSourceOf`, for the server to sign. */
export function imageAssetResource(key: string, threadId: ThreadId): AssetResource {
  const path = key.slice(key.indexOf(":") + 1);
  return {
    _tag: "media-file",
    threadId,
    path,
    ...(key.startsWith("relative:") ? { hostOnly: true as const } : {}),
  };
}

/** A bare `www.` address or an email, as GitHub autolinks them, as something a browser opens. */
export function linkUrlOf(href: string): string {
  if (/^www\./i.test(href)) return `https://${href}`;
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(href)) return `mailto:${href}`;
  return href;
}
