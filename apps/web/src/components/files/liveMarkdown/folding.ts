import { codeFolding, foldGutter, foldKeymap } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";

const SVG = "http://www.w3.org/2000/svg";

/** The gutter's chevron: it points right at a folded block and down at an open one. */
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.className = open ? "cm-lp-fold" : "cm-lp-fold cm-lp-fold-closed";
  marker.title = open ? "Fold" : "Unfold";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "m9 6 6 6-6 6");
  svg.append(path);
  marker.append(svg);
  return marker;
}

/**
 * Folds a heading's section or a block down to its first line. What can fold
 * comes from the Markdown language itself; this adds the gutter and the keys.
 */
export const folding: Extension = [
  codeFolding(),
  foldGutter({ markerDOM: foldMarker }),
  keymap.of(foldKeymap),
];
