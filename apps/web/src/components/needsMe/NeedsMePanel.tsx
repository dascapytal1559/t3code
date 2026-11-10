import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ModelRouting, Objectives, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { bridgeDecisionsAtom, type BridgeDecision } from "../../state/decisions";
import { bridgeRulesAtom } from "../../state/rules";
import { useProject, useQuietThreadShell, useServerConfigs } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon, ProjectNameMonogram } from "../ProjectFavicon";
import { BridgeSection, useObjectivesPinned } from "./BridgeSection";
import { DecisionDetail } from "./DecisionDetail";
import {
  bridgeDecisionKey,
  bridgeSetting,
  groupNeedsMeDecisions,
  needsMeRowDetail,
  parseObjective,
  splitObjectives,
  type NeedsMeGroups,
} from "./needsMe.logic";
import { useNeedsMeOpenRow } from "./needsMeReveal";
import { pickBridgeRules } from "./rules.logic";
import { RulesSection } from "./RulesSection";

type RowGroup = keyof NeedsMeGroups<unknown>;

/**
 * The Bridge tab: the user's objectives, then the decisions FirstMate needs now beside any chat,
 * then those with a return date under Scheduled, then FirstMate's model routing table, then the
 * user's rules for FirstMate.
 */
export function NeedsMePanel(props: { readonly threadRef: ScopedThreadRef }) {
  const decisions = useAtomValue(bridgeDecisionsAtom);
  const serverConfigs = useServerConfigs();
  const objectives = bridgeSetting(serverConfigs, props.threadRef.environmentId, "objectives");
  const modelRouting = bridgeSetting(serverConfigs, props.threadRef.environmentId, "modelRouting");
  const rules = pickBridgeRules(useAtomValue(bridgeRulesAtom), props.threadRef.environmentId);
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const groups = groupNeedsMeDecisions(decisions, new Date(nowMs));
  const row = (group: RowGroup) => (item: BridgeDecision) => (
    <NeedsMeRow
      key={bridgeDecisionKey(item)}
      item={item}
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
      <BridgeSection id="needs-you" title="Needs you" count={groups.open.length}>
        {groups.open.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Nothing needs you right now.</p>
        ) : (
          groups.open.map(row("open"))
        )}
      </BridgeSection>
      {groups.scheduled.length === 0 ? null : (
        <BridgeSection id="scheduled" title="Scheduled" count={groups.scheduled.length}>
          {groups.scheduled.map(row("scheduled"))}
        </BridgeSection>
      )}
      {modelRouting === null ? null : (
        <ModelRoutingSection
          modelRouting={modelRouting}
          environmentId={props.threadRef.environmentId}
        />
      )}
      {rules === null ? null : (
        <RulesSection environmentId={rules.environmentId} state={rules.state} />
      )}
    </div>
  );
}

/**
 * Read-only: FirstMate sets them over MCP, each a name over a summary of about two lines. One card
 * per objective in a wrapping grid, shown in full; cards in a row share its height.
 */
function ObjectivesSection(props: {
  readonly objectives: Objectives;
  readonly environmentId: EnvironmentId;
}) {
  const [pinned, setPinned] = useObjectivesPinned();
  const entries = splitObjectives(props.objectives.markdown);
  return (
    <BridgeSection
      id="objectives"
      title="Objectives"
      count={entries.length}
      pin={{ pinned, onToggle: () => setPinned(!pinned) }}
    >
      <ul className="mb-1 grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-2">
        {entries.map((entry) => {
          const objective = parseObjective(entry);
          return (
            <li
              key={entry}
              className="min-w-0 rounded-xl border border-border bg-muted/60 px-4 py-3"
            >
              {objective.name === undefined ? null : (
                <h3 className="mb-1 text-sm leading-5 font-semibold text-foreground">
                  {objective.name}
                </h3>
              )}
              {objective.text === "" ? null : (
                <ChatMarkdown
                  text={objective.text}
                  cwd={undefined}
                  environmentId={props.environmentId}
                  className="text-sm leading-relaxed text-foreground/80 [&_p]:my-0"
                />
              )}
            </li>
          );
        })}
      </ul>
    </BridgeSection>
  );
}

/** Read-only: FirstMate sets it over MCP. `.bridge-routing` stacks its rows in a narrow panel. */
function ModelRoutingSection(props: {
  readonly modelRouting: ModelRouting;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <BridgeSection id="model-routing" title="Model routing">
      <ChatMarkdown
        text={props.modelRouting.markdown}
        cwd={undefined}
        environmentId={props.environmentId}
        className="bridge-routing px-2 text-sm text-foreground/80"
      />
    </BridgeSection>
  );
}

function NeedsMeRow(props: {
  readonly item: BridgeDecision;
  readonly group: RowGroup;
  readonly hostRef: ScopedThreadRef;
  readonly nowMs: number;
}) {
  const { environmentId, replyTo, decision } = props.item;
  const key = bridgeDecisionKey(props.item);
  const open = useNeedsMeOpenRow((state) => state.openKey === key);
  const setOpenKey = useNeedsMeOpenRow((state) => state.setOpenKey);
  // A decision that names no project is about FirstMate's own.
  const coordinator = useQuietThreadShell(
    decision.projectName === undefined && replyTo !== null
      ? scopeThreadRef(environmentId, replyTo)
      : null,
  );
  const project = useProject(
    coordinator === null ? null : scopeProjectRef(environmentId, coordinator.projectId),
  );
  const projectName = decision.projectName ?? project?.title ?? null;
  const detail = needsMeRowDetail(decision, props.group, props.nowMs);

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
              {decision.title}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {decision.projectName !== undefined ? (
              <ProjectNameMonogram name={decision.projectName} className="size-3.5" />
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
          <DecisionDetail item={props.item} hostRef={props.hostRef} />
        </div>
      ) : null}
    </div>
  );
}
