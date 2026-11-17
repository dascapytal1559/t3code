import { codeFolding, foldGutter, foldKeymap } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";

import { detailsKeymap } from "./details";
import { chevronIcon } from "./widgets";

/** The gutter's chevron: it points right at a folded block and down at an open one. */
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.className = open ? "cm-lp-fold" : "cm-lp-fold cm-lp-fold-closed";
  marker.title = open ? "Fold" : "Unfold";
  marker.append(chevronIcon());
  return marker;
}

/**
 * Folds a heading's section or a block down to its first line. What can fold
 * comes from the Markdown language itself; this adds the gutter and the keys.
 * `<details>` blocks fold on their own (details.ts) and answer the same keys first.
 */
export const folding: Extension = [
  codeFolding(),
  foldGutter({ markerDOM: foldMarker }),
  keymap.of([...detailsKeymap, ...foldKeymap]),
];
