import { type EditorView, WidgetType } from "@codemirror/view";

import { frontmatterRows } from "./frontmatter";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

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
    box.setAttribute("aria-label", this.checked ? "Completed task" : "Open task");
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
