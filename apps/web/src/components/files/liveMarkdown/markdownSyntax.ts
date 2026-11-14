import type { syntaxTree } from "@codemirror/language";
import type { MarkdownConfig } from "@lezer/markdown";

export type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

const OPEN_BRACKET = 91;

/** `[[note]]` and `[[note|label]]`. Drawn as a link; opening the note is not built. */
const wikiLinkSyntax: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink" }, { name: "WikiLinkMark" }],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
        const rest = cx.slice(pos + 2, cx.end);
        const close = rest.indexOf("]]");
        if (close < 1 || /[[\]\n]/.test(rest.slice(0, close))) return -1;
        const end = pos + 2 + close + 2;
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

export const liveMarkdownExtensions: readonly MarkdownConfig[] = [wikiLinkSyntax];

export const HEADING_NODE = /^(?:ATX|Setext)Heading([1-6])$/;
