import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { tags } from "@lezer/highlight";

const language = (name: string, alias: string[], load: () => Promise<LanguageSupport>) =>
  LanguageDescription.of({ name, alias, load });
const bundled = (name: string, alias: string[], support: LanguageSupport) =>
  LanguageDescription.of({ name, alias, support });

/**
 * Grammars for fenced code. HTML, CSS and JavaScript arrive with the Markdown
 * language, which reads inline HTML with them. Every other grammar is its own
 * chunk, fetched the first time a fence names it.
 */
export const codeLanguages: readonly LanguageDescription[] = [
  bundled("TypeScript", ["ts", "tsx", "typescript"], javascript({ typescript: true, jsx: true })),
  bundled("JavaScript", ["js", "jsx", "javascript", "mjs", "cjs"], javascript({ jsx: true })),
  bundled("CSS", ["css"], css()),
  bundled("HTML", ["html", "xml", "svg"], html()),
  language("JSON", ["json", "jsonc", "json5"], () =>
    import("@codemirror/lang-json").then((module) => module.json()),
  ),
  language("Python", ["py", "python"], () =>
    import("@codemirror/lang-python").then((module) => module.python()),
  ),
  language("YAML", ["yaml", "yml"], () =>
    import("@codemirror/lang-yaml").then((module) => module.yaml()),
  ),
  language("Rust", ["rs", "rust"], () =>
    import("@codemirror/lang-rust").then((module) => module.rust()),
  ),
  language("Go", ["go", "golang"], () =>
    import("@codemirror/lang-go").then((module) => module.go()),
  ),
  language("SQL", ["sql"], () => import("@codemirror/lang-sql").then((module) => module.sql())),
  language("Shell", ["sh", "bash", "zsh", "shell", "console"], () =>
    import("@codemirror/legacy-modes/mode/shell").then(
      (module) => new LanguageSupport(StreamLanguage.define(module.shell)),
    ),
  ),
];

/** Token colours come from the stylesheet, so they follow the app's theme. */
export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
    color: "var(--lmd-code-keyword)",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--lmd-code-string)" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--lmd-code-comment)",
    fontStyle: "italic",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--lmd-code-number)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--lmd-code-function)",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--lmd-code-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--lmd-code-property)" },
]);
