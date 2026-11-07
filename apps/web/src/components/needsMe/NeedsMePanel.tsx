import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, Objectives, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { useNowMinute } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { useProject, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon, ProjectNameMonogram } from "../ProjectFavicon";
import { DecisionDetail } from "./DecisionDetail";
import {
  bridgeObjectives,
  formatCalendarDay,
  groupNeedsMeDecisions,
  needsMeRowDetail,
  splitObjectives,
  type NeedsMeGroups,
} from "./needsMe.logic";
import { useNeedsMeOpenRow } from "./needsMeReveal";

type RowGroup = keyof NeedsMeGroups<unknown>;

/**
 * The Bridge tab: the user's objectives, then FirstMate's open decisions beside any chat, then
 * undated snoozes under Later and dated ones under Scheduled.
 */
export function NeedsMePanel(props: { readonly threadRef: ScopedThreadRef }) {
  const shells = useQuietThreadShells();
  const objectives = bridgeObjectives(useServerConfigs(), props.threadRef.environmentId);
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const groups = groupNeedsMeDecisions(shells, new Date(nowMs));
  const row = (group: RowGroup) => (thread: EnvironmentThreadShell) => (
    <NeedsMeRow
      key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
      thread={thread}
      group={group}
      hostRef={props.threadRef}
      nowMs={nowMs}
    />
  );

  return (
    <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3">
      {objectives === null ? null : (
        <ObjectivesSection objectives={objectives} environmentId={props.threadRef.environmentId} />
      )}
      <NeedsMeSection title="Needs you" count={groups.open.length}>
        {groups.open.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Nothing needs you right now.</p>
        ) : (
          groups.open.map(row("open"))
        )}
      </NeedsMeSection>
      {groups.later.length === 0 ? null : (
        <NeedsMeSection title="Later" count={groups.later.length}>
          {groups.later.map(row("later"))}
        </NeedsMeSection>
      )}
      {groups.scheduled.length === 0 ? null : (
        <NeedsMeSection title="Scheduled" count={groups.scheduled.length}>
          {groups.scheduled.map(row("scheduled"))}
        </NeedsMeSection>
      )}
    </div>
  );
}

const OBJECTIVES_DEFAULT_WIDTH = 720;
const OBJECTIVES_MIN_WIDTH = 280;
const OBJECTIVES_MAX_WIDTH = 1600;
const OBJECTIVES_KEY_STEP = 16;

/**
 * Read-only: FirstMate sets them over MCP. Each objective is its own card, capped at a max width
 * the user drags from the right edge. Collapsed, each is clamped to two lines (on the inner text, so
 * the card's padding is never clipped) and the list to a short height, so Needs you stays in view.
 */
function ObjectivesSection(props: {
  readonly objectives: Objectives;
  readonly environmentId: EnvironmentId;
}) {
  const [expanded, setExpanded] = useState(false);
  const [maxWidth, setMaxWidth] = useState(OBJECTIVES_MAX_WIDTH);
  const { width, setWidth, handlers } = useResizableWidth({
    storageKey: "t3code.bridgeObjectivesWidth",
    defaultWidth: OBJECTIVES_DEFAULT_WIDTH,
    minWidth: OBJECTIVES_MIN_WIDTH,
    maxWidth,
    edge: "right",
  });
  const { lastReviewed } = props.objectives;
  return (
    <section
      ref={(section) => {
        const panel = section?.parentElement;
        if (!panel) return;
        const measure = () => {
          const style = getComputedStyle(panel);
          const available =
            panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          setMaxWidth(
            Math.max(OBJECTIVES_MIN_WIDTH, Math.min(OBJECTIVES_MAX_WIDTH, Math.floor(available))),
          );
        };
        measure();
        return observeResize(panel, measure);
      }}
      className="relative mb-4"
      style={
        {
          [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
          maxWidth: `var(${RESIZABLE_WIDTH_PROPERTY})`,
        } as CSSProperties
      }
    >
      <RightPanelResizeHandle
        handlers={handlers}
        label="Resize objectives"
        className="left-auto -right-1"
        tabIndex={0}
        aria-valuenow={width}
        aria-valuemin={OBJECTIVES_MIN_WIDTH}
        aria-valuemax={maxWidth}
        onDoubleClick={() => setWidth(OBJECTIVES_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          let nextWidth: number;
          switch (event.key) {
            case "ArrowLeft":
              nextWidth = width - OBJECTIVES_KEY_STEP;
              break;
            case "ArrowRight":
              nextWidth = width + OBJECTIVES_KEY_STEP;
              break;
            case "Home":
              nextWidth = OBJECTIVES_MIN_WIDTH;
              break;
            case "End":
              nextWidth = maxWidth;
              break;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          setWidth(nextWidth);
        }}
      />
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center gap-1 rounded-md px-2 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Objectives</span>
        {lastReviewed === undefined ? null : (
          <span className="tabular-nums">· reviewed {formatCalendarDay(lastReviewed)}</span>
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn("ms-auto size-3.5 shrink-0", expanded && "rotate-180")}
        />
      </button>
      <div className={cn("flex flex-col gap-2", !expanded && "max-h-72 overflow-hidden")}>
        {splitObjectives(props.objectives.markdown).map((entry) => (
          <div
            key={entry}
            className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
          >
            <ChatMarkdown
              text={entry}
              cwd={undefined}
              environmentId={props.environmentId}
              className={cn("[&_p]:my-0", !expanded && "[&_p]:line-clamp-2")}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function NeedsMeSection(props: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="mb-4">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {props.title} · {props.count}
      </h3>
      {props.children}
    </section>
  );
}

function NeedsMeRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly group: RowGroup;
  readonly hostRef: ScopedThreadRef;
  readonly nowMs: number;
}) {
  const { thread } = props;
  const decisionRef = scopeThreadRef(thread.environmentId, thread.id);
  const key = scopedThreadKey(decisionRef);
  const open = useNeedsMeOpenRow((state) => state.openKey === key);
  const setOpenKey = useNeedsMeOpenRow((state) => state.setOpenKey);
  const project = useProject(
    thread.decisionProjectName === undefined
      ? scopeProjectRef(thread.environmentId, thread.projectId)
      : null,
  );
  const projectName = thread.decisionProjectName ?? project?.title ?? null;
  const detail = needsMeRowDetail(thread, props.group, props.nowMs);

  return (
    <div className={cn("rounded-lg", open && "bg-accent/40")}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        onClick={() => setOpenKey(open ? null : key)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {thread.title}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {thread.decisionProjectName !== undefined ? (
              <ProjectNameMonogram name={thread.decisionProjectName} className="size-3.5" />
            ) : project ? (
              <ProjectFavicon project={project} className="size-3.5" />
            ) : null}
            {projectName === null ? null : <span className="min-w-0 truncate">{projectName}</span>}
            {projectName === null ? null : <span aria-hidden>·</span>}
            <span className="shrink-0 tabular-nums">{detail}</span>
          </span>
        </span>
      </button>
      {open ? (
        <div className="ps-8 pe-2">
          <DecisionDetail decisionRef={decisionRef} hostRef={props.hostRef} />
        </div>
      ) : null}
    </div>
  );
}
