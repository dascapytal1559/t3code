import { type EditorView, WidgetType } from "@codemirror/view";

import { frontmatterRows } from "./frontmatter";
import { clickedLink, previewConfig } from "./previewConfig";
import { type TableCell, type TableInline, tableModel } from "./tableModel";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

/** A chevron pointing right, which CSS turns down for something open. */
export function chevronIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 6 6 6-6 6");
  svg.append(path);
  return svg;
}

export class BulletWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const span = element("span", "cm-lp-bullet");
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

export class OrderedWidget extends WidgetType {
  readonly label: string;
  readonly width: number;
  constructor(label: string, width: number) {
    super();
    this.label = label;
    this.width = width;
  }
  override eq(other: OrderedWidget) {
    return other.label === this.label && other.width === this.width;
  }
  toDOM() {
    const span = element("span", "cm-lp-ordered");
    span.style.width = `${this.width}rem`;
    span.textContent = this.label;
    return span;
  }
}

export class CheckboxWidget extends WidgetType {
  readonly checked: boolean;
  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const wrap = element("span", "cm-lp-task");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.setAttribute(
      "aria-label",
      this.checked
        ? m(msg("Completed task"))
        : m(msg("Open task", { $context: "an unchecked task" })),
    );
    // Keeps the caret where it is; the box is no place to type.
    box.addEventListener("mousedown", (event) => event.preventDefault());
    // The box is drawn from the text, so a click edits the text and never the box itself.
    box.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = view.posAtDOM(wrap);
      const marker = /^\[([ xX])\]/.exec(view.state.doc.sliceString(pos, pos + 3));
      if (!marker || view.state.readOnly) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " },
        userEvent: "input.task",
      });
    });
    wrap.append(box);
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    return element("span", "cm-lp-hr");
  }
}

/** Lucide outlines (ISC), as single paths. */
const CALLOUT_ICONS: Record<string, string> = {
  note: "M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  tip: "M9 18h6m-5 4h4m1.09-8a5.5 5.5 0 1 0-6.18 0c.6.5 1.09 1.3 1.09 2h4c0-.7.5-1.5 1.09-2Z",
  important: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v2m0 4h.01",
  warning:
    "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  caution: "M12 8v4m0 4h.01M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2Z",
};

export class CalloutTitleWidget extends WidgetType {
  readonly kind: string;
  readonly title: string;
  constructor(kind: string, title: string) {
    super();
    this.kind = kind;
    this.title = title;
  }
  override eq(other: CalloutTitleWidget) {
    return other.kind === this.kind && other.title === this.title;
  }
  toDOM() {
    const span = element("span", "cm-lp-callout-title");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", CALLOUT_ICONS[this.kind] ?? CALLOUT_ICONS.note ?? "");
    svg.append(path);
    span.append(svg, this.title);
    return span;
  }
}

export class CodeLabelWidget extends WidgetType {
  readonly language: string;
  constructor(language: string) {
    super();
    this.language = language;
  }
  override eq(other: CodeLabelWidget) {
    return other.language === this.language;
  }
  toDOM() {
    const span = element("span", "cm-lp-code-label");
    span.textContent = this.language || "text";
    return span;
  }
}

/** The frontmatter block as a card. A click puts the caret in the block, which shows its text. */
export class FrontmatterWidget extends WidgetType {
  readonly source: string;
  constructor(source: string) {
    super();
    this.source = source;
  }
  override eq(other: FrontmatterWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    // The same markup as MarkdownPropertiesCard, which markdownProperties.css styles.
    const card = element("div", "cm-lp-frontmatter");
    card.dataset.markdownProperties = "";
    const head = document.createElement("div");
    head.dataset.head = "";
    head.textContent = "Properties";
    card.append(head);
    for (const row of frontmatterRows(this.source)) {
      const key = document.createElement("span");
      key.dataset.key = "";
      key.textContent = row.key;
      const value = document.createElement("span");
      value.dataset.value = "";
      value.textContent = row.value;
      card.append(key, value);
    }
    card.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const { doc } = view.state;
      view.dispatch({ selection: { anchor: doc.line(Math.min(2, doc.lines)).to } });
      view.focus();
    });
    return card;
  }
  override ignoreEvent() {
    return true;
  }
}

/** An image where its Markdown is. Without a URL yet, or with a blocked one, its alt text stands in. */
export class ImageWidget extends WidgetType {
  readonly url: string | null;
  readonly alt: string;
  /** Pixels, as Obsidian's `![[a.png|300x200]]` asks. */
  readonly width: number | null;
  readonly height: number | null;
  constructor(
    url: string | null,
    alt: string,
    width: number | null = null,
    height: number | null = null,
  ) {
    super();
    this.url = url;
    this.alt = alt;
    this.width = width;
    this.height = height;
  }
  override eq(other: ImageWidget) {
    return (
      other.url === this.url &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }
  toDOM(view: EditorView) {
    const wrap = element("span", "cm-lp-image");
    if (this.url === null) {
      wrap.classList.add("cm-lp-image-missing");
      wrap.textContent = this.alt || "Image";
      return wrap;
    }
    const image = document.createElement("img");
    image.src = this.url;
    image.alt = this.alt;
    image.draggable = false;
    this.size(image);
    // The line is taller once the picture has loaded.
    image.addEventListener("load", () => view.requestMeasure());
    wrap.append(image);
    return wrap;
  }
  /** A refreshed URL swaps the picture in place, so the old one shows until the new one loads. */
  override updateDOM(dom: HTMLElement) {
    const image = dom.querySelector("img");
    if (!image || this.url === null) return false;
    image.src = this.url;
    image.alt = this.alt;
    this.size(image);
    return true;
  }
  private size(image: HTMLImageElement) {
    // An asked-for size may be wider than the page's usual cap, though never than the page.
    image.style.width = this.width === null ? "" : `${this.width}px`;
    image.style.height = this.height === null ? "" : `${this.height}px`;
    image.style.maxWidth = this.width === null ? "" : "100%";
    image.style.objectFit = this.height === null ? "" : "contain";
  }
}

const INLINE_TAGS = { strong: "strong", emphasis: "em", strike: "del" } as const;

function appendInline(parent: HTMLElement, content: readonly TableInline[]) {
  for (const node of content) {
    if (node.kind === "text") {
      parent.append(node.text);
    } else if (node.kind === "code") {
      const code = element("code", "cm-lp-code");
      code.textContent = node.text;
      parent.append(code);
    } else if (node.kind === "link") {
      const link = element("span", "cm-lp-link");
      link.dataset.href = node.href;
      appendInline(link, node.children);
      parent.append(link);
    } else {
      const wrapper = document.createElement(INLINE_TAGS[node.kind]);
      appendInline(wrapper, node.children);
      parent.append(wrapper);
    }
  }
}

/** A table drawn as a table. A click in a cell puts the caret at that cell in the table's source. */
export class TableWidget extends WidgetType {
  readonly source: string;
  constructor(source: string) {
    super();
    this.source = source;
  }
  override eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = element("div", "cm-lp-table-wrap");
    const model = tableModel(this.source);
    if (model === null) {
      wrap.textContent = this.source;
      return wrap;
    }
    const table = element("table", "cm-lp-table");
    const row = (cells: readonly TableCell[], tag: "th" | "td") => {
      const tr = document.createElement("tr");
      cells.forEach((cell, column) => {
        const td = document.createElement(tag);
        td.dataset.offset = String(cell.offset);
        const align = model.align[column];
        if (align) td.style.textAlign = align;
        appendInline(td, cell.content);
        tr.append(td);
      });
      return tr;
    };
    const head = document.createElement("thead");
    head.append(row(model.head, "th"));
    const body = document.createElement("tbody");
    body.append(...model.rows.map((cells) => row(cells, "td")));
    table.append(head, body);
    wrap.append(table);

    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (clickedLink(event) !== null) return;
      const cell = event.target instanceof Element ? event.target.closest("th,td") : null;
      const offset = cell instanceof HTMLElement ? Number(cell.dataset.offset) : 0;
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + offset } });
      view.focus();
    });
    wrap.addEventListener("click", (event) => {
      const link = clickedLink(event);
      if (link !== null) view.state.facet(previewConfig).onOpenLink(link, event);
    });
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}
