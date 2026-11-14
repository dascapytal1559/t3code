import { formatPercent } from "@t3tools/shared/usageFormat";
import type { MergedOrigins } from "@t3tools/shared/usageMerge";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { originAxes, type OriginDevice } from "./usageOriginAxes";

// Amber and blue: no provider on the Usage page uses either hue.
const DEVICE: Record<OriginDevice, { readonly label: string; readonly color: string }> = {
  phone: {
    label: "Phone",
    color: "[--origin:oklch(0.72_0.16_65)] dark:[--origin:oklch(0.78_0.15_70)]",
  },
  computer: {
    label: "Computer",
    color: "[--origin:oklch(0.55_0.19_264)] dark:[--origin:oklch(0.66_0.17_264)]",
  },
};
const DEVICES: readonly OriginDevice[] = ["phone", "computer"];
const NEUTRAL_INK = "color-mix(in oklab, var(--foreground) 70%, var(--background))";

const stripes = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in oklab, ${color} 35%, var(--background)) 3px 6px)`;
const SOLID: CSSProperties = { backgroundColor: "var(--origin)" };
const STRIPED: CSSProperties = { backgroundImage: stripes("var(--origin)") };

/** Usage traced to a phone or computer, in the same shape as the "by type" share bars. */
export function UsageOriginBreakdown({
  label,
  origins,
  valueOf,
  format,
}: {
  readonly label: string;
  readonly origins: MergedOrigins;
  readonly valueOf: (amount: { readonly costUsd: number; readonly totalTokens: number }) => number;
  readonly format: (value: number) => string;
}) {
  const axes = originAxes(origins);
  const parts = DEVICES.map((key) => {
    const direct = valueOf(axes[key].direct);
    const coordinated = valueOf(axes[key].coordinated);
    return { key, direct, coordinated, total: direct + coordinated };
  });
  const traced = parts.reduce((sum, part) => sum + part.total, 0);
  if (traced <= 0) return null;

  const segments = parts.flatMap((part) => [
    { part, side: "direct" as const, value: part.direct, style: SOLID },
    { part, side: "coordinated" as const, value: part.coordinated, style: STRIPED },
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        <span className="flex gap-3 text-xs text-muted-foreground">
          <Swatch style={{ backgroundColor: NEUTRAL_INK }}>Direct</Swatch>
          <Swatch style={{ backgroundImage: stripes(NEUTRAL_INK) }}>Coordinated</Swatch>
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${parts.map((part) => `${DEVICE[part.key].label} ${format(part.direct)} direct, ${format(part.coordinated)} coordinated`).join("; ")}`}
        className="flex h-2 gap-0.5"
      >
        {segments
          .filter((segment) => segment.value > 0)
          .map(({ part, side, value, style }) => (
            <Tooltip key={`${part.key}-${side}`}>
              <TooltipTrigger
                render={
                  <div
                    className={cn(
                      "h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full",
                      DEVICE[part.key].color,
                    )}
                    style={{ ...style, flex: `${value} 1 0` }}
                  />
                }
              />
              <TooltipPopup>
                {DEVICE[part.key].label} {side} · {format(value)} · {formatPercent(value / traced)}
              </TooltipPopup>
            </Tooltip>
          ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        {parts.map((part) => (
          <Swatch key={part.key} className={DEVICE[part.key].color} style={SOLID}>
            <span className="text-muted-foreground">{DEVICE[part.key].label}</span>
            <span className="text-foreground">{format(part.total)}</span>
            <span className="text-muted-foreground">
              {formatPercent(part.total / traced, 0)} · {format(part.direct)} direct ·{" "}
              {format(part.coordinated)} coordinated
            </span>
          </Swatch>
        ))}
      </div>
    </div>
  );
}

function Swatch({
  children,
  className,
  style,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly style: CSSProperties;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        aria-hidden
        className={cn("inline-block size-2 shrink-0 rounded-xs", className)}
        style={style}
      />
      {children}
    </span>
  );
}
