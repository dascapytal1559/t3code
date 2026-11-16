import { Facet } from "@codemirror/state";

/** Where an image written in the file loads from. */
export type ImageSource =
  | { readonly kind: "url"; readonly url: string }
  /** A file the app must sign a URL for: asked for through `onImageNeeded`, answered with `setImageUrls`. */
  | { readonly kind: "asset"; readonly key: string }
  | { readonly kind: "blocked" };

/** What the editor asks of the app around it. The editor itself knows nothing of T3. */
export interface LivePreviewConfig {
  readonly resolveImage: (source: string) => ImageSource;
  /** Where an Obsidian embed `![[name]]` of a picture loads from; until it has a URL its source shows. */
  readonly resolveImageEmbed: (target: string) => ImageSource;
  /** Called once for each asset key that comes into view. */
  readonly onImageNeeded: (key: string) => void;
  readonly onOpenLink: (href: string, event: MouseEvent) => void;
}

const standalone: LivePreviewConfig = {
  resolveImage: () => ({ kind: "blocked" }),
  resolveImageEmbed: () => ({ kind: "blocked" }),
  onImageNeeded: () => {},
  onOpenLink: () => {},
};

export const previewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig>({
  combine: (values) => values[0] ?? standalone,
});

/**
 * The link under a plain click. Alt-click is left alone so the caret can be put
 * inside a link to edit it.
 */
export function clickedLink(event: MouseEvent): string | null {
  if (event.button !== 0 || event.altKey || !(event.target instanceof Element)) return null;
  return event.target.closest<HTMLElement>("[data-href]")?.dataset.href ?? null;
}
