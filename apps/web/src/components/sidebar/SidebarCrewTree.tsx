import { cn } from "~/lib/utils";

/** Where a crewmate row sits under its coordinator: on the tree's guide line, or indented alone. */
export type CrewTreePlace = "branch" | "last" | "indent";

// The rows sit in one flat sortable list, so each draws its own segment; hovering or focusing any
// segment lights the whole tree, which collapses as one. The colour is opaque so the trunk and an
// elbow drawn over it never brighten where they meet.
const CREW_TREE_COLOR_CLASS_NAME =
  "pointer-events-none absolute transition-colors [--crew-tree-line:color-mix(in_srgb,var(--contrast-sidebar-muted-foreground)_40%,var(--sidebar))] [[role=tree]:has([data-crew-tree]:hover,[data-crew-tree]:focus-visible)_&]:[--crew-tree-line:color-mix(in_srgb,var(--contrast-sidebar-muted-foreground)_80%,var(--sidebar))]";

// The guide line runs down the centre of the coordinator card's size-4 leading icon, which sits
// at the card's content inset; crewmate rows start where that icon ends.
const CREW_TREE_LINE_START_CLASS_NAME =
  "start-[calc(var(--sidebar-row-content-inset)_+_0.5rem_-_1px)]";
export const CREW_TREE_TRUNK_CLASS_NAME = cn(
  CREW_TREE_COLOR_CLASS_NAME,
  CREW_TREE_LINE_START_CLASS_NAME,
  "w-0.5 bg-(--crew-tree-line)",
);
export const CREW_TREE_INDENT_CLASS_NAME = "ps-[calc(var(--sidebar-row-content-inset)_+_1rem)]";
export const CREW_TREE_GUTTER_WIDTH_CLASS_NAME =
  "w-[calc(var(--sidebar-row-content-inset)_+_1rem)]";

/** The guide line beside a crewmate row; clicking it collapses the crew. */
export function CrewTreeGutter(props: { last: boolean; onToggle: () => void }) {
  return (
    <div
      aria-hidden
      data-crew-tree
      data-testid="sidebar-crew-tree-line"
      className={cn("absolute inset-y-0 start-0 cursor-pointer", CREW_TREE_GUTTER_WIDTH_CLASS_NAME)}
      onClick={props.onToggle}
    >
      {props.last ? null : <span className={cn(CREW_TREE_TRUNK_CLASS_NAME, "inset-y-0")} />}
      {/* One stroke that turns into the row on the card's corner radius. */}
      <span
        className={cn(
          CREW_TREE_COLOR_CLASS_NAME,
          CREW_TREE_LINE_START_CLASS_NAME,
          "end-0 top-0 bottom-[calc(50%_-_1px)] rounded-es-md border-s-2 border-b-2 border-(--crew-tree-line)",
        )}
      />
    </div>
  );
}
