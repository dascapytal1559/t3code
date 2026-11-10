import { ChevronRightIcon, PinIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useId, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type BridgeSectionId = "objectives" | "needs-you" | "scheduled" | "model-routing";

const collapsedKey = (id: BridgeSectionId) => `t3code:bridge:collapsed:${id}`;
const OBJECTIVES_PINNED_KEY = "t3code:bridge:objectives-pinned";

/** Whether Objectives is pinned open on this client; a new client starts pinned. */
export function useObjectivesPinned() {
  return useLocalStorage(OBJECTIVES_PINNED_KEY, true, Schema.Boolean);
}

/**
 * A Bridge section whose header collapses it, remembered per client. A pinned section stays open
 * and its header cannot collapse it.
 */
export function BridgeSection(props: {
  readonly id: BridgeSectionId;
  readonly title: string;
  readonly count?: number;
  readonly pin?: { readonly pinned: boolean; readonly onToggle: () => void };
  readonly children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useLocalStorage(collapsedKey(props.id), false, Schema.Boolean);
  const bodyId = useId();
  const pinned = props.pin?.pinned === true;
  const expanded = pinned || !collapsed;
  const label = props.count === undefined ? props.title : `${props.title} · ${props.count}`;

  return (
    <section aria-label={props.title} className="mb-4">
      <div className="flex items-center gap-1 pe-1 pb-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          disabled={pinned}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none disabled:cursor-default disabled:hover:text-muted-foreground"
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", expanded && "rotate-90", pinned && "opacity-40")}
          />
          <span className="min-w-0 truncate">{label}</span>
        </button>
        {props.pin === undefined ? null : (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${props.title}` : `Pin ${props.title} open`}
            title={pinned ? `Unpin ${props.title}` : `Pin ${props.title} open`}
            onClick={props.pin.onToggle}
          >
            <PinIcon className={cn("size-3.5", pinned && "fill-current text-foreground")} />
          </Button>
        )}
      </div>
      {expanded ? <div id={bodyId}>{props.children}</div> : null}
    </section>
  );
}
