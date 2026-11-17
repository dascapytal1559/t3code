import { formatPercent } from "@t3tools/shared/usageFormat";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { emphasisColor, emphasisPositions } from "./usageEmphasis";

export interface ShareSegment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/** How many segments the legend sets in aligned columns, two to a line. */
const ALIGNED = 4;

export function UsageShareBar({
  label,
  segments,
  format,
  aside,
}: {
  readonly label: string;
  readonly segments: readonly ShareSegment[];
  readonly format: (value: number) => string;
  readonly aside?: ReactNode;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  const positions = emphasisPositions(visible.map((segment) => segment.value));
  const cells = (segment: ShareSegment, index: number) => (
    <>
      <span
        aria-hidden
        className={cn("size-2 rounded-xs", index % 2 === 1 && index < ALIGNED && "ms-3")}
        style={{ backgroundColor: segment.color }}
      />
      <span className="text-muted-foreground">{segment.label}</span>
      <span className="text-right" style={{ color: emphasisColor(positions[index] ?? 1) }}>
        {format(segment.value)}
      </span>
      <span className="text-right text-muted-foreground">
        {formatPercent(segment.value / total)}
      </span>
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        {aside}
      </div>
      {/* The legend below carries every figure; the bar's tooltips are pointer-only. */}
      <div aria-hidden className="flex h-2 gap-0.5">
        {visible.map((segment) => (
          <Tooltip key={segment.label}>
            <TooltipTrigger
              render={
                <div
                  className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
                  style={{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }}
                />
              }
            />
            <TooltipPopup>
              {segment.label} · {format(segment.value)} · {formatPercent(segment.value / total)}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      {/* A fifth segment follows the second line where it fits and wraps under it where it does not. */}
      <div
        role="list"
        aria-label={label}
        className="flex flex-wrap items-end gap-x-3 gap-y-1 text-xs tabular-nums"
      >
        <div
          role="presentation"
          className="grid grid-cols-[repeat(8,max-content)] items-center gap-x-1 gap-y-1"
        >
          {visible.slice(0, ALIGNED).map((segment, index) => (
            <div key={segment.label} role="listitem" className="contents">
              {cells(segment, index)}
            </div>
          ))}
        </div>
        {visible.slice(ALIGNED).map((segment, index) => (
          <div key={segment.label} role="listitem" className="flex items-center gap-1">
            {cells(segment, index + ALIGNED)}
          </div>
        ))}
      </div>
    </div>
  );
}
