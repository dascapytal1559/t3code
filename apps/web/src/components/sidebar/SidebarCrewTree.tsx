import { cn } from "~/lib/utils";

/** Where a crewmate row sits under its coordinator: on the tree's guide line, or indented alone. */
export type CrewTreePlace = "branch" | "last" | "indent";

// The rows sit in one flat sortable list, so each draws its own segment; hovering or focusing any
// segment lights the whole tree, which collapses as one.
export const CREW_TREE_LINE_CLASS_NAME =
  "pointer-events-none absolute bg-sidebar-foreground/25 transition-colors [[role=tree]:has([data-crew-tree]:hover,[data-crew-tree]:focus-visible)_&]:bg-sidebar-foreground/60";

/** The guide line beside a crewmate row; clicking it collapses the crew. */
export function CrewTreeGutter(props: { last: boolean; onToggle: () => void }) {
  return (
    <div
      aria-hidden
      data-crew-tree
      data-testid="sidebar-crew-tree-line"
      className="absolute inset-y-0 start-0 w-4 cursor-pointer"
      onClick={props.onToggle}
    >
      <span
        className={cn(
          CREW_TREE_LINE_CLASS_NAME,
          "start-[7px] top-0 w-px",
          props.last ? "h-1/2" : "bottom-0",
        )}
      />
      <span className={cn(CREW_TREE_LINE_CLASS_NAME, "start-[7px] end-0 top-1/2 h-px")} />
    </div>
  );
}
