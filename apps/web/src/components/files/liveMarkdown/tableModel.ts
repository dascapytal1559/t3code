import { GFM, parser } from "@lezer/markdown";

import { liveMarkdownExtensions, type SyntaxNode } from "./markdownSyntax";

const tableParser = parser.configure([GFM, ...liveMarkdownExtensions]);

export type TableInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | {
      readonly kind: "strong" | "emphasis" | "strike";
      readonly children: readonly TableInline[];
    }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly TableInline[] };

export interface TableCell {
  /** Where the cell's text starts in the table's source, for putting the caret there. */
  readonly offset: number;
  readonly content: readonly TableInline[];
}

export type TableAlign = "left" | "center" | "right" | null;

export interface TableModel {
  readonly align: readonly TableAlign[];
  readonly head: readonly TableCell[];
  readonly rows: ReadonlyArray<readonly TableCell[]>;
}

const WRAPPERS: Record<string, "strong" | "emphasis" | "strike"> = {
  StrongEmphasis: "strong",
  Emphasis: "emphasis",
  Strikethrough: "strike",
};

/** The drawn content of `parent` between two offsets: marks dropped, formatting kept as structure. */
function inlineBetween(
  parent: SyntaxNode,
  from: number,
  to: number,
  source: string,
): TableInline[] {
  const out: TableInline[] = [];
  const text = (value: string) => {
    const last = out.at(-1);
    if (value === "") return;
    if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + value };
    else out.push({ kind: "text", text: value });
  };
  let at = from;
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (child.from < from || child.to > to) continue;
    text(source.slice(at, child.from));
    at = child.to;
    const wrapper = WRAPPERS[child.name];
    if (wrapper) {
      out.push({ kind: wrapper, children: inlineBetween(child, child.from, child.to, source) });
    } else if (child.name === "InlineCode") {
      const marks = child.getChildren("CodeMark");
      out.push({
        kind: "code",
        text: source.slice(marks[0]?.to ?? child.from, marks.at(-1)?.from ?? child.to),
      });
    } else if (child.name === "Link" || child.name === "Autolink") {
      const url = child.getChild("URL");
      const marks = child.getChildren("LinkMark");
      const href = url ? source.slice(url.from, url.to) : "";
      const [open, close] = marks;
      const label =
        child.name === "Link" && open && close
          ? inlineBetween(child, open.to, close.from, source)
          : [{ kind: "text" as const, text: href }];
      if (url) out.push({ kind: "link", href, children: label });
      else text(source.slice(child.from, child.to));
    } else if (child.name === "URL") {
      const href = source.slice(child.from, child.to);
      out.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
    } else if (child.name === "Escape") {
      text(source.slice(child.from + 1, child.to));
    } else if (!child.name.endsWith("Mark")) {
      text(source.slice(child.from, child.to));
    }
  }
  text(source.slice(at, to));
  return out;
}

/** A row's cells, empty ones included: the grammar only gives nodes to cells with text. */
function cellsOf(row: SyntaxNode, source: string): TableCell[] {
  const cells: TableCell[] = [];
  let pending: TableCell | null = null;
  let emptyAt = row.from;
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableCell") {
      pending = {
        offset: child.from,
        content: inlineBetween(child, child.from, child.to, source),
      };
    } else if (child.name === "TableDelimiter") {
      // A pipe that opens the row closes no cell.
      if (child.from > row.from) cells.push(pending ?? { offset: emptyAt, content: [] });
      pending = null;
      emptyAt = Math.min(child.to + 1, row.to);
    }
  }
  if (pending) cells.push(pending);
  return cells;
}

function alignOf(delimiterLine: string): TableAlign[] {
  return delimiterLine
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => {
      const dashes = cell.trim();
      if (dashes.startsWith(":") && dashes.endsWith(":")) return "center";
      if (dashes.endsWith(":")) return "right";
      return dashes.startsWith(":") ? "left" : null;
    });
}

/** Reads the source of one Markdown table. Null when the text is not a table. */
export function tableModel(source: string): TableModel | null {
  const table = tableParser.parse(source).topNode.getChild("Table");
  const header = table?.getChild("TableHeader");
  const delimiter = table?.getChild("TableDelimiter");
  if (!table || !header || !delimiter) return null;
  return {
    align: alignOf(source.slice(delimiter.from, delimiter.to)),
    head: cellsOf(header, source),
    rows: table.getChildren("TableRow").map((row) => cellsOf(row, source)),
  };
}
