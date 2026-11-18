import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";

/**
 * Find and replace in the file, in a bar above it (Mod-f). A match inside a
 * drawn block, such as a table, opens that block as its source when stepped to.
 */
export const findReplace = (): Extension => [
  search({ top: true }),
  EditorState.phrases.of({
    Find: m(msg("Find in file")),
    Replace: m(msg("Replace with")),
    next: m(msg("Next")),
    previous: m(msg("Previous")),
    "match case": m(msg("Match case")),
    replace: m(msg("Replace", { $context: "verb, replaces one match" })),
    "replace all": m(msg("Replace all")),
    close: m(msg("Close", { $context: "verb, closes the find bar" })),
  }),
  keymap.of(searchKeymap),
];
