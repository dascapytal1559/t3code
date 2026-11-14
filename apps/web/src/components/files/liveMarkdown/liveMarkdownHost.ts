import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import type { AssetResource, ThreadId } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";

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
