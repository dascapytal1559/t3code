import type { EnvironmentId, Objectives } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { BridgeSection, useObjectivesPinned } from "./BridgeSection";
import { objectiveRow, splitObjectives } from "./needsMe.logic";

/**
 * Read-only reminders: FirstMate sets them over MCP. Each objective is a bordered one-line row
 * showing its name, collapsed by default; one with a description expands to show it.
 */
export function ObjectivesSection(props: {
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
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <ObjectiveRow key={entry} entry={entry} environmentId={props.environmentId} />
        ))}
      </ul>
    </BridgeSection>
  );
}

function ObjectiveRow(props: { readonly entry: string; readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const { title, body } = objectiveRow(props.entry);
  const titleText = (
    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
  );
  return (
    <li className={cn("min-w-0 rounded-lg border border-border/70", open && "bg-accent/40")}>
      {body === "" ? (
        <div className="flex items-start gap-2 px-2 py-1.5 ps-8">{titleText}</div>
      ) : (
        <>
          <button
            type="button"
            aria-expanded={open}
            className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
            onClick={() => setOpen(!open)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
            />
            {titleText}
          </button>
          {open ? (
            <ChatMarkdown
              text={body}
              cwd={undefined}
              environmentId={props.environmentId}
              className="ps-8 pe-2 pb-2 text-sm leading-relaxed text-foreground/80 [&_p]:my-0"
            />
          ) : null}
        </>
      )}
    </li>
  );
}
