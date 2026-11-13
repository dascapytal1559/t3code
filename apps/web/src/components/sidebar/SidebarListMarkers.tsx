import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useLayoutEffect } from "react";
import { cn } from "~/lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import {
  CREW_TREE_HEADER_INDENT_CLASS_NAME,
  CrewBranchGutter,
  crewBranchContinues,
} from "./SidebarCrewTree";
import { CREW_BRANCH_LABEL, type CrewBranch } from "./coordinatorGroup.logic";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
  "data-crew-branch"?: string;
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the projected drop box inside the scroll viewport as drag transforms move it
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [node, props.revealOverflow, transform?.y]);
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      data-crew-branch={props["data-crew-branch"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      // Revealing on every drag scrolls the list out from under the pointer.
      revealOverflow={
        props.marker === "settled-placeholder" && props.showHint && props.isDropTarget
      }
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

/**
 * One branch of the crew tree: a compact row reading "<count> <label>" that expands or collapses
 * its own crewmates. The row stays, with a zero, when the branch is empty so the tree keeps its shape.
 */
export function SidebarCrewBranchHeader(props: {
  branch: CrewBranch;
  first: boolean;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = CREW_BRANCH_LABEL[props.branch];
  const Chevron = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <SortableSidebarMarker
      marker={`crew-${props.branch}-header`}
      data-testid={`sidebar-crew-${props.branch}-header`}
      data-crew-branch={props.branch}
      className={cn(
        "relative",
        CREW_TREE_HEADER_INDENT_CLASS_NAME,
        crewBranchContinues(props.branch) && "-mb-px",
      )}
    >
      <CrewBranchGutter branch={props.branch} first={props.first} />
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`shelf:crew-${props.branch}`}
        data-crew-tree={props.branch}
        aria-expanded={props.expanded}
        aria-label={`${props.count} ${label}`}
        onClick={props.onToggle}
        className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md ps-1 pe-1.5 text-xs tabular-nums text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <Chevron aria-hidden className="size-3.5 shrink-0" />
        <span>{props.count}</span>
        <span>{label}</span>
      </button>
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  /** A muted trailing count. */
  count: number;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf = props.marker.slice(0, -"-header".length);
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("relative mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        data-sidebar-row={`shelf:${shelf}`}
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}
