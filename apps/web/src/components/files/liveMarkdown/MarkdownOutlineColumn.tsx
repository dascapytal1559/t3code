import { useEffect, useRef, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";

import type { LiveMarkdownEditor } from "./liveMarkdownEditor";

/**
 * The outline pinned beside the live editor: the file's headings, kept current
 * as you type, with the section you are reading marked. A click jumps there.
 */
export function MarkdownOutlineColumn({ editor }: { readonly editor: LiveMarkdownEditor }) {
  const { headings, active } = useSyncExternalStore(editor.watchOutline, editor.outlineSnapshot);
  const listRef = useRef<HTMLOListElement>(null);
  const top = Math.min(...headings.map((heading) => heading.level));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the marked heading inside the column's own scroll area, which React does not own
  useEffect(() => {
    const list = listRef.current;
    const item = active < 0 ? null : list?.children[active];
    if (!list || !(item instanceof HTMLElement)) return;
    // scrollIntoView would also move the panel's overflow-hidden layout.
    const above = item.offsetTop - list.scrollTop;
    if (above < 0) list.scrollTop = item.offsetTop;
    else if (above + item.offsetHeight > list.clientHeight)
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [active]);

  return (
    <nav
      aria-label="Outline"
      data-markdown-outline-column
      className="flex w-44 shrink-0 flex-col border-e pt-4 text-xs"
    >
      <div className="shrink-0 px-4 pb-1.5 text-2xs font-medium text-muted-foreground">Outline</div>
      {headings.length === 0 ? (
        <p className="px-4 text-muted-foreground">No headings</p>
      ) : (
        <ol ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {headings.map((heading, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- headings repeat and carry no id; the list follows the file's order
            <li key={index}>
              <button
                type="button"
                aria-current={index === active ? "location" : undefined}
                onClick={() => editor.jumpToHeading(index)}
                className={cn(
                  "line-clamp-2 w-full break-words rounded-sm py-1 pe-2 text-start text-muted-foreground hover:bg-accent hover:text-foreground",
                  index === active && "bg-accent font-medium text-foreground",
                )}
                style={{ paddingInlineStart: `${0.5 + (heading.level - top) * 0.75}rem` }}
              >
                {heading.text || "Untitled"}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
