import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * Find and replace in the file, in a bar above it (Mod-f). A match inside a
 * drawn block, such as a table, opens that block as its source when stepped to.
 */
export const findReplace: Extension = [
  search({ top: true }),
  EditorState.phrases.of({
    Find: "Find in file",
    Replace: "Replace with",
    next: "Next",
    previous: "Previous",
    "match case": "Match case",
    replace: "Replace",
    "replace all": "Replace all",
    close: "Close",
  }),
  keymap.of(searchKeymap),
];
