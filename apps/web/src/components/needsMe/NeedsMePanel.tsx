import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, Objectives, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProject, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon, ProjectNameMonogram } from "../ProjectFavicon";
import { DecisionDetail } from "./DecisionDetail";
import {
  bridgeObjectives,
  groupNeedsMeDecisions,
  needsMeRowDetail,
  parseObjective,
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

/**
 * Read-only: FirstMate sets them over MCP. One plate across the panel with each objective's name
 * over its whole description; the user sets the measure by resizing the panel itself.
 */
function ObjectivesSection(props: {
  readonly objectives: Objectives;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <section className="mb-5 rounded-xl border border-border bg-muted/60 px-5 pt-3.5 pb-1">
      <h3 className="pb-2 text-xs font-medium text-muted-foreground">High level objectives</h3>
      <ul className="flex flex-col">
        {splitObjectives(props.objectives.markdown).map((entry) => {
          const objective = parseObjective(entry);
          return (
            <li
              key={entry}
              className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 border-t border-border/70 py-3.5 first:border-t-0 first:pt-2.5"
            >
              <span aria-hidden className="text-sm leading-5 text-muted-foreground">
                •
              </span>
              <div className="min-w-0">
                {objective.name === undefined ? null : (
                  <h4 className="mb-1 text-sm leading-5 font-semibold text-foreground">
                    {objective.name}
                  </h4>
                )}
                {objective.text === "" ? null : (
                  <ChatMarkdown
                    text={objective.text}
                    cwd={undefined}
                    environmentId={props.environmentId}
                    className="text-sm leading-relaxed text-foreground/80 [&_p]:my-0"
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
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
