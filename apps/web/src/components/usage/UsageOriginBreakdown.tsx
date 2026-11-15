import { USAGE_ORIGINS_RECORDED_SINCE } from "@t3tools/contracts";
import { formatPercent } from "@t3tools/shared/usageFormat";
import type { MergedOrigins } from "@t3tools/shared/usageMerge";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { originAxes, type OriginDevice } from "./usageOriginAxes";

const ORIGINS_RECORDED_SINCE_LABEL = new Date(USAGE_ORIGINS_RECORDED_SINCE).toLocaleDateString(
  undefined,
  { day: "numeric", month: "short" },
);

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
// Dimmer than the key's Direct grey, so Unknown never reads as direct usage.
const UNKNOWN: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--foreground) 38%, var(--background))",
};

const stripes = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in oklab, ${color} 35%, var(--background)) 3px 6px)`;
const SOLID: CSSProperties = { backgroundColor: "var(--origin)" };
const STRIPED: CSSProperties = { backgroundImage: stripes("var(--origin)") };

/** Usage by the device it traces to, then usage with no recorded parent, in the shape of the "by type" bars. */
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
  const unknown = valueOf(axes.unknown);
  const total = parts.reduce((sum, part) => sum + part.total, unknown);
  if (total <= 0) return null;
  const untraceable = [
    { value: valueOf(axes.beforeOrigins), label: `before ${ORIGINS_RECORDED_SINCE_LABEL}` },
    { value: valueOf(axes.archive), label: "archived from other machines" },
  ].flatMap(({ value, label }) => (value > 0 ? [`${format(value)} ${label}`] : []));

  const segments = [
    ...parts.flatMap((part) => [
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
        name: `${DEVICE[part.key].label} coordinated`,
      },
    ]),
    { id: "unknown", value: unknown, className: undefined, style: UNKNOWN, name: "Unknown" },
  ];

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
        aria-label={`${label}: ${[
          ...parts.map(
            (part) =>
              `${DEVICE[part.key].label} ${format(part.direct)} direct, ${format(part.coordinated)} coordinated`,
          ),
          `Unknown ${format(unknown)}`,
        ].join("; ")}`}
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
      <div className="flex flex-col gap-1 text-xs tabular-nums">
        {parts
          .filter((part) => part.total > 0)
          .map((part) => (
            <span key={part.key} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <Swatch className={DEVICE[part.key].color} style={SOLID}>
                <span className="text-muted-foreground">{DEVICE[part.key].label}</span>
                <span className="text-foreground">{format(part.total)}</span>
                <span className="text-muted-foreground">
                  {formatPercent(part.total / total, 0)} ·
                </span>
              </Swatch>
              <Swatch className={DEVICE[part.key].color} style={SOLID}>
                <span className="text-foreground">{format(part.direct)}</span>
              </Swatch>
              <Swatch className={DEVICE[part.key].color} style={STRIPED}>
                <span className="text-foreground">{format(part.coordinated)}</span>
              </Swatch>
            </span>
          ))}
        {unknown > 0 ? (
          <Swatch style={UNKNOWN}>
            <span className="text-muted-foreground">Unknown</span>
            <span className="text-foreground">{format(unknown)}</span>
            <span className="text-muted-foreground">{formatPercent(unknown / total, 0)}</span>
          </Swatch>
        ) : null}
        {untraceable.length > 0 ? (
          <span className="text-muted-foreground">Can't trace: {untraceable.join(" · ")}</span>
        ) : null}
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
