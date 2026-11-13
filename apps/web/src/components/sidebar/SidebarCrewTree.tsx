import { cn } from "~/lib/utils";
import { CREW_BRANCHES, type CrewBranch } from "./coordinatorGroup.logic";

/**
 * Where a crewmate row sits under its branch: on the branch's guide line, or indented alone when
 * the route thread stays visible in a collapsed branch.
 */
export type CrewTreePlace = "branch" | "last" | "indent";

// The rows sit in one flat sortable list, so each draws its own segment. Hovering or focusing a
// branch's toggle or guide line lights that branch's segments only, since it collapses on its own.
// The colour is opaque so the trunk and an elbow drawn over it never brighten where they meet.
const CREW_TREE_COLOR_CLASS_NAMES: Record<CrewBranch, string> = {
  working:
    "pointer-events-none absolute transition-colors [--crew-tree-line:color-mix(in_srgb,var(--contrast-sidebar-muted-foreground)_40%,var(--sidebar))] [[role=tree]:has([data-crew-tree=working]:hover,[data-crew-tree=working]:focus-visible)_[data-crew-branch=working]_&]:[--crew-tree-line:color-mix(in_srgb,var(--contrast-sidebar-muted-foreground)_80%,var(--sidebar))]",
  waiting:
    "pointer-events-none absolute transition-colors [--crew-tree-line:color-mix(in_srgb,var(--contrast-sidebar-muted-foreground)_40%,var(--sidebar))] [[role=tree]:has([data-crew-tree=waiting]:hover,[data-crew-tree=waiting]:focus-visible)_[data-crew-branch=waiting]_&]:[--crew-tree-line:color-mix(in_srgb,var(--contrast-sidebar-muted-foreground)_80%,var(--sidebar))]",
};

// The 1px guide lines sit centred in 1rem gutters, so the gap from the coordinator card's left
// edge to a line equals the gap from the line to the cards beside it. The first line carries the
// branch headers; the second, one gutter further in, carries a branch's crewmates.
const HEADER_LINE_START_CLASS_NAME = "start-[calc(0.5rem_-_0.5px)]";
const CREW_LINE_START_CLASS_NAME = "start-[calc(1.5rem_-_0.5px)]";
export const CREW_TREE_HEADER_INDENT_CLASS_NAME = "ps-4";
export const CREW_TREE_INDENT_CLASS_NAME = "ps-8";

/** The line the coordinator card and its first branch header draw into the list gap between them. */
export const crewTreeTrunkClassName = (branch: CrewBranch) =>
  cn(
    CREW_TREE_COLOR_CLASS_NAMES[branch],
    HEADER_LINE_START_CLASS_NAME,
    "w-px bg-(--crew-tree-line)",
  );

const lastBranch = CREW_BRANCHES.at(-1);

function Elbow(props: { branch: CrewBranch; startClassName: string }) {
  // One stroke that turns into the row on the card's corner radius.
  return (
    <span
      className={cn(
        CREW_TREE_COLOR_CLASS_NAMES[props.branch],
        props.startClassName,
        "end-0 top-0 bottom-[calc(50%_-_0.5px)] rounded-es-md border-s border-b border-(--crew-tree-line)",
      )}
    />
  );
}

/** The guide line beside a branch header, which hangs from the coordinator's line. */
export function CrewBranchGutter(props: { branch: CrewBranch; first: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 start-0 w-4">
      {props.first ? (
        <span className={cn(crewTreeTrunkClassName(props.branch), "-top-[3px] h-[3px]")} />
      ) : null}
      {props.branch === lastBranch ? null : (
        <span className={cn(crewTreeTrunkClassName(props.branch), "inset-y-0")} />
      )}
      <Elbow branch={props.branch} startClassName={HEADER_LINE_START_CLASS_NAME} />
    </div>
  );
}

/** The guide lines beside a crewmate row; clicking them collapses its branch. */
export function CrewTreeGutter(props: {
  branch: CrewBranch;
  place: CrewTreePlace;
  onToggle: () => void;
}) {
  const color = CREW_TREE_COLOR_CLASS_NAMES[props.branch];
  return (
    <div
      aria-hidden
      data-crew-tree={props.branch}
      data-testid="sidebar-crew-tree-line"
      className="absolute inset-y-0 start-0 w-8 cursor-pointer"
      onClick={props.onToggle}
    >
      {/* The branch header's line keeps running down past this branch's rows to the next header. */}
      {props.branch === lastBranch ? null : (
        <span
          className={cn(
            color,
            HEADER_LINE_START_CLASS_NAME,
            "w-px bg-(--crew-tree-line) inset-y-0",
          )}
        />
      )}
      {props.place === "indent" ? null : (
        <>
          {props.place === "last" ? null : (
            <span
              className={cn(
                color,
                CREW_LINE_START_CLASS_NAME,
                "w-px bg-(--crew-tree-line) inset-y-0",
              )}
            />
          )}
          <Elbow branch={props.branch} startClassName={CREW_LINE_START_CLASS_NAME} />
        </>
      )}
    </div>
  );
}

/** Whether a branch's guide line runs on past its rows to the next branch header. */
export const crewBranchContinues = (branch: CrewBranch) => branch !== lastBranch;
