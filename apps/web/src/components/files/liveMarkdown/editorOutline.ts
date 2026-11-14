import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { frontmatterField } from "./livePreview";
import { HEADING_NODE } from "./markdownSyntax";
import type { OutlineItem } from "./outline";

export interface EditorHeading extends OutlineItem {
  /** Where the heading starts in the document. */
  readonly from: number;
}

/** Blocks a heading can sit inside. Nothing else is searched. */
const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);
const PARSE_BUDGET_MS = 200;

/** The file's headings in order, each with its text as drawn: no marks, no link addresses. */
export function headingsOf(state: EditorState): EditorHeading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  const frontmatter = state.field(frontmatterField, false) ?? 0;
  const headings: EditorHeading[] = [];
  tree.iterate({
    enter(ref) {
      const heading = HEADING_NODE.exec(ref.name);
      if (!heading) return CONTAINERS.has(ref.name);
      // The grammar reads the end of a frontmatter block as a heading.
      if (ref.from < frontmatter) return false;
      let text = "";
      let at = ref.from;
      tree.iterate({
        from: ref.from,
        to: ref.to,
        enter(part) {
          const hidden =
            part.name.endsWith("Mark") ||
            part.name === "LinkTitle" ||
            (part.name === "URL" && part.node.parent?.name === "Link");
          if (!hidden) return;
          text += state.doc.sliceString(at, Math.max(at, part.from));
          at = Math.max(at, part.to);
          return false;
        },
      });
      text += state.doc.sliceString(at, Math.max(at, ref.to));
      headings.push({
        level: Number(heading[1]),
        text: text.replace(/\s+/g, " ").trim(),
        from: ref.from,
      });
      return false;
    },
  });
  return headings;
}
