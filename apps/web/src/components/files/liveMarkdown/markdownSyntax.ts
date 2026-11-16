import type { syntaxTree } from "@codemirror/language";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

export type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

const OPEN_BRACKET = 91;
const OPEN_PAREN = 40;
const BANG = 33;

/** The end of a `[[...]]` starting at `pos`, or -1. */
function wikiLinkEnd(cx: InlineContext, pos: number): number {
  if (cx.char(pos) !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
  const rest = cx.slice(pos + 2, cx.end);
  const close = rest.indexOf("]]");
  if (close < 1 || /[[\]\n]/.test(rest.slice(0, close))) return -1;
  const end = pos + 2 + close + 2;
  if (cx.char(end) === OPEN_PAREN || cx.char(end) === OPEN_BRACKET) return -1;
  return end;
}

/**
 * `[[note]]` and `[[note|label]]`, drawn as a link; opening the note is not built.
 * `![[picture.png]]` is Obsidian's embed of a picture, drawn as one. An embedded
 * note is not built and parses as before.
 */
const wikiLinkSyntax: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink" }, { name: "WikiLinkMark" }, { name: "ImageEmbed" }],
  parseInline: [
    {
      name: "ImageEmbed",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== BANG) return -1;
        const end = wikiLinkEnd(cx, pos + 1);
        if (end < 0 || imageEmbedOf(cx.slice(pos + 3, end - 2)) === null) return -1;
        return cx.addElement(cx.elt("ImageEmbed", pos, end));
      },
    },
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, _next, pos) {
        const end = wikiLinkEnd(cx, pos);
        if (end < 0) return -1;
        return cx.addElement(
          cx.elt("WikiLink", pos, end, [
            cx.elt("WikiLinkMark", pos, pos + 2),
            cx.elt("WikiLinkMark", end - 2, end),
          ]),
        );
      },
    },
  ],
};

export interface ImageEmbed {
  /** The file as written, without its `#subpath`. */
  readonly target: string;
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
}

const EMBED_IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const EMBED_SIZE = /^(\d+)(?:x(\d+))?$/;

/** What `![[inner]]` embeds when it is a picture: `a.png`, `a.png|300`, `a.png|300x200`, `a.png|alt`. */
export function imageEmbedOf(inner: string): ImageEmbed | null {
  const [file = "", ...options] = inner.split("|");
  const target = file.split("#")[0]?.trim() ?? "";
  if (!EMBED_IMAGE.test(target)) return null;
  const size = options.length > 0 ? EMBED_SIZE.exec(options.at(-1)?.trim() ?? "") : null;
  const alt = (size ? options.slice(0, -1) : options).join("|").trim();
  return {
    target,
    alt: alt || target,
    width: size ? Number(size[1]) : null,
    height: size?.[2] ? Number(size[2]) : null,
  };
}

export const liveMarkdownExtensions: readonly MarkdownConfig[] = [wikiLinkSyntax];

export const HEADING_NODE = /^(?:ATX|Setext)Heading([1-6])$/;
