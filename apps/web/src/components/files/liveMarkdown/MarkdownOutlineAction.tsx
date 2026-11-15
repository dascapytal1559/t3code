import { ListTreeIcon } from "lucide-react";
import { type RefObject, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import { FileSurfaceAction } from "../fileSurfaceChrome";
import { type MarkdownOutlineSource, type OutlineItem, renderedOutline } from "./outline";
import type { OutlineColumn } from "./useOutlineColumn";

/**
 * The file panel's outline button: the file's headings in a list, and a click
 * jumps to one. The live editor names its own headings; for the read-only
 * rendered view they are read from the headings it drew. Where the live editor
 * has room for its pinned outline column, the button shows or hides that instead.
 */
export function MarkdownOutlineAction(props: {
  /** The live editor's outline while it is the surface on screen. */
  readonly live: MarkdownOutlineSource | null;
  /** The panel's content, where the rendered view draws its headings. */
  readonly rendered: RefObject<HTMLElement | null>;
  readonly column: OutlineColumn;
}) {
  // Read when the list opens, so it always matches the file as it is now.
  const [headings, setHeadings] = useState<readonly OutlineItem[] | null>(null);
  if (props.column.fits) {
    return (
      <FileSurfaceAction
        label={props.column.pinned ? "Hide outline" : "Show outline"}
        pressed={props.column.pinned}
        onPress={props.column.togglePinned}
      >
        <ListTreeIcon className="size-3.5" />
      </FileSurfaceAction>
    );
  }
  const source = () => props.live ?? renderedOutline(props.rendered.current);
  const top = Math.min(...(headings ?? []).map((heading) => heading.level));

  return (
    <Menu
      open={headings !== null}
      onOpenChange={(open) => setHeadings(open ? source().headings() : null)}
    >
      <MenuTrigger
        render={
          <Button
            type="button"
            className="shrink-0"
            aria-label="Outline"
            title="Outline"
            variant="ghost"
            size="icon-sm"
          />
        }
      >
        <ListTreeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="max-w-80">
        {headings?.length === 0 ? <MenuItem disabled>No headings</MenuItem> : null}
        {headings?.map((heading, index) => (
          <MenuItem
            // oxlint-disable-next-line react/no-array-index-key -- headings repeat, and the list is rebuilt each time it opens
            key={index}
            onClick={() => source().jump(index)}
          >
            <span
              className="min-w-0 truncate"
              style={{ paddingInlineStart: `${(heading.level - top) * 0.75}rem` }}
            >
              {heading.text || "Untitled"}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
