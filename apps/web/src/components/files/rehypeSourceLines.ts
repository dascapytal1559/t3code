import type { Element, Root, RootContent } from "hast";

const BLOCK_TAGS = new Set([
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

/** Marks each block with the 1-based source lines it was parsed from, as `start-end`. */
export function rehypeSourceLines() {
  const visit = (node: Root | RootContent) => {
    if (node.type !== "root" && node.type !== "element") return;
    if (node.type === "element") mark(node);
    for (const child of node.children) visit(child);
  };
  return (tree: Root) => visit(tree);
}

function mark(node: Element) {
  const start = node.position?.start.line;
  const end = node.position?.end.line;
  if (!BLOCK_TAGS.has(node.tagName) || start === undefined || end === undefined) return;
  node.properties.dataSourceLines = `${start}-${end}`;
}
