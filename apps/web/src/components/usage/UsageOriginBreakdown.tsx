import { formatPercent } from "@t3tools/shared/usageFormat";
import type { MergedOrigins } from "@t3tools/shared/usageMerge";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { emphasisColor, emphasisPositions } from "./usageEmphasis";
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

/** Usage by the device it traces to, in the shape of the "by type" bars; with no phone evidence, the computer. */
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
  const total = parts.reduce((sum, part) => sum + part.total, 0);
  if (total <= 0) return null;
  // One scale for the block: the totals and their parts are the same kind of figure.
  const figures = parts.flatMap((part) => [part.total, part.direct, part.coordinated]);
  const positions = emphasisPositions(figures);
  const figure = (value: number) => (
    <span
      className="text-right"
      style={{ color: emphasisColor(positions[figures.indexOf(value)] ?? 1) }}
    >
      {format(value)}
    </span>
  );

  const segments = parts.flatMap((part) => [
    {
      id: `${part.key}-direct`,
      value: part.direct,
      className: DEVICE[part.key].color,
      style: SOLID,
      name: `${DEVICE[part.key].label} direct`,
    },
    {
      id: `${part.key}-coordinated`,
      value: part.coordinated,
      className: DEVICE[part.key].color,
      style: STRIPED,
      name: `${DEVICE[part.key].label} orchestrated`,
    },
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        <span className="flex gap-3 text-xs text-muted-foreground">
          <Swatch style={{ backgroundColor: NEUTRAL_INK }}>Direct</Swatch>
          <Swatch style={{ backgroundImage: stripes(NEUTRAL_INK) }}>Orchestrated</Swatch>
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${parts
          .map(
            (part) =>
              `${DEVICE[part.key].label} ${format(part.direct)} direct, ${format(part.coordinated)} orchestrated`,
          )
          .join("; ")}`}
        className="flex h-2 gap-0.5"
      >
        {segments
          .filter((segment) => segment.value > 0)
          .map(({ id, value, className, style, name }) => (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <div
                    className={cn(
                      "h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full",
                      className,
                    )}
                    style={{ ...style, flex: `${value} 1 0` }}
                  />
                }
              />
              <TooltipPopup>
                {name} · {format(value)} · {formatPercent(value / total)}
              </TooltipPopup>
            </Tooltip>
          ))}
      </div>
      <div className="grid grid-cols-[repeat(9,max-content)] items-center gap-x-1 gap-y-1 text-xs tabular-nums">
        {parts
          .filter((part) => part.total > 0)
          .map((part) => (
            <div key={part.key} className="contents">
              <Dot className={DEVICE[part.key].color} style={SOLID} />
              <span className="text-muted-foreground">{DEVICE[part.key].label}</span>
              {figure(part.total)}
              <span className="text-right text-muted-foreground">
                {formatPercent(part.total / total, 0)}
              </span>
              <span className="text-muted-foreground">·</span>
              <Dot className={DEVICE[part.key].color} style={SOLID} />
              {figure(part.direct)}
              <Dot className={cn(DEVICE[part.key].color, "ms-1")} style={STRIPED} />
              {figure(part.coordinated)}
            </div>
          ))}
      </div>
    </div>
  );
}

function Dot({ className, style }: { readonly className?: string; readonly style: CSSProperties }) {
  return (
    <i
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-xs", className)}
      style={style}
    />
  );
}

function Swatch({
  children,
  style,
}: {
  readonly children: ReactNode;
  readonly style: CSSProperties;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Dot style={style} />
      {children}
    </span>
  );
}
