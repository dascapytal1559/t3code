import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProject, useQuietThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon, ProjectNameMonogram } from "../ProjectFavicon";
import { DecisionDetail, formatDay } from "./DecisionDetail";
import { decisionAgeTimestamp, groupNeedsMeDecisions } from "./needsMe.logic";
import { useNeedsMeOpenRow } from "./needsMeReveal";

type RowGroup = "open" | "later";

/** FirstMate's open decisions beside any chat, with snoozed ones under Later. */
export function NeedsMePanel(props: { readonly threadRef: ScopedThreadRef }) {
  const shells = useQuietThreadShells();
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
    </div>
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
  const detail =
    props.group === "later"
      ? thread.snoozedUntil == null
        ? "no date"
        : `back ${formatDay(thread.snoozedUntil)}`
      : formatRelativeTimeLabel(decisionAgeTimestamp(thread), props.nowMs);

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
