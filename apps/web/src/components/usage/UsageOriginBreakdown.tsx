import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { MergedOrigins } from "@t3tools/shared/usageMerge";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  originAxes,
  type OriginAmount,
  type OriginDevice,
  type UnrecordedReason,
  type UnrecordedSide,
} from "./usageOriginAxes";

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

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
const UNRECORDED_INK = ink(32);
const NEUTRAL_INK = ink(70);

const stripes = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in oklab, ${color} 35%, var(--background)) 3px 6px)`;
const SOLID: CSSProperties = { backgroundColor: "var(--origin)" };
const STRIPED: CSSProperties = { backgroundImage: stripes("var(--origin)") };

const REASON_LABEL: Record<UnrecordedReason, string> = {
  crew: "FirstMate crew prompts with no recorded cause",
  notification: "background-task updates the provider sends into a thread",
  agent: "other agent prompts with no recorded cause",
  unstamped: "typed before devices were stamped",
  server: "made by the server",
  stampedUnknown: "stamped, device unknown",
};

export function UsageOriginBreakdown({
  origins,
  metric,
  totalCostUsd,
  totalTokens,
  loading,
}: {
  readonly origins: MergedOrigins;
  readonly metric: "tokens" | "cost";
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly loading: boolean;
}) {
  const axes = originAxes(origins);
  const valueOf = (amount: Pick<OriginAmount, "costUsd" | "totalTokens">) =>
    metric === "tokens" ? amount.totalTokens : amount.costUsd;
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const total = metric === "tokens" ? totalTokens : totalCostUsd;
  const share = (value: number) => (total > 0 ? formatPercent(value / total) : "");
  const device = (key: OriginDevice) => {
    const { direct, coordinated } = axes.devices[key];
    return { direct: valueOf(direct), coordinated: valueOf(coordinated) };
  };
  const deviceValue = (key: OriginDevice) => device(key).direct + device(key).coordinated;
  const traced = deviceValue("phone") + deviceValue("computer");
  const unrecorded = valueOf(axes.unrecorded.direct) + valueOf(axes.unrecorded.coordinated);
  const promptGone = valueOf(axes.promptGone);
  const outside = valueOf(axes.outside);

  const reasonLine = (side: UnrecordedSide) =>
    side.reasons
      .map((entry) => {
        const value = valueOf(entry);
        return value > 0
          ? `${format(value)} ${REASON_LABEL[entry.reason]}`
          : `${formatCount(entry.prompts)} ${REASON_LABEL[entry.reason]}`;
      })
      .join(" · ");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">By origin</h2>
        <p className="text-xs text-muted-foreground">
          How much came from your phone or your computer, typed directly or coordinated by agents
          that a phone or computer prompt started.
        </p>
      </div>

      <div className={cn("grid grid-cols-2 gap-4", figureClass(loading))}>
        {DEVICES.map((key) => (
          <div key={key} className={cn("flex min-w-0 flex-col", DEVICE[key].color)}>
            <span className="flex items-center gap-2 text-sm text-foreground">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={SOLID} />
              {DEVICE[key].label}
              {traced > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {formatPercent(deviceValue(key) / traced, 0)} of traced
                </span>
              ) : null}
            </span>
            <span className="text-3xl leading-tight font-medium text-foreground tabular-nums">
              {format(deviceValue(key))}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {format(device(key).direct)} direct · {format(device(key).coordinated)} coordinated
            </span>
          </div>
        ))}
      </div>

      {traced > 0 ? (
        <div className={cn("flex flex-col gap-2", figureClass(loading))}>
          <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-sm">
            {DEVICES.flatMap((key) => [
              <Segment
                key={`${key}-direct`}
                value={device(key).direct}
                className={DEVICE[key].color}
                style={SOLID}
              />,
              <Segment
                key={`${key}-coordinated`}
                value={device(key).coordinated}
                className={DEVICE[key].color}
                style={STRIPED}
              />,
            ])}
          </div>
          <Legend>
            <Swatch style={{ backgroundColor: NEUTRAL_INK }}>Direct</Swatch>
            <Swatch style={{ backgroundImage: stripes(NEUTRAL_INK) }}>Coordinated</Swatch>
          </Legend>
        </div>
      ) : null}

      <div className={cn("mt-1 flex flex-col gap-2", figureClass(loading))}>
        <p className="text-xs text-muted-foreground tabular-nums">
          Traced to a device: {format(traced)} of {format(total)}
          {total > 0 ? ` (${formatPercent(traced / total)})` : ""}
        </p>
        <div aria-hidden className="flex h-1.5 gap-0.5 overflow-hidden rounded-sm">
          {DEVICES.map((key) => (
            <Segment
              key={key}
              value={deviceValue(key)}
              className={DEVICE[key].color}
              style={SOLID}
            />
          ))}
          <Segment value={unrecorded + promptGone} style={{ backgroundColor: UNRECORDED_INK }} />
          <Segment
            value={outside}
            className="rounded-xs border border-muted-foreground/50"
            style={{}}
          />
        </div>
        <Legend>
          {DEVICES.map((key) => (
            <Swatch key={key} className={DEVICE[key].color} style={SOLID}>
              {DEVICE[key].label} {share(deviceValue(key))}
            </Swatch>
          ))}
          <Swatch style={{ backgroundColor: UNRECORDED_INK }}>
            Device not recorded {share(unrecorded + promptGone)}
          </Swatch>
          <Swatch className="border border-muted-foreground" style={{}}>
            Outside T3 runs {share(outside)}
          </Swatch>
        </Legend>
      </div>

      <div className="mt-1 flex flex-col">
        <h3 className="pb-1 text-xs font-normal text-muted-foreground">Not traced to a device</h3>
        <LeftoverRow
          label="Device not recorded, direct"
          detail={reasonLine(axes.unrecorded.direct)}
          value={valueOf(axes.unrecorded.direct)}
          format={format}
          share={share}
          loading={loading}
        />
        <LeftoverRow
          label="Device not recorded, coordinated"
          detail={reasonLine(axes.unrecorded.coordinated)}
          value={valueOf(axes.unrecorded.coordinated)}
          format={format}
          share={share}
          loading={loading}
        />
        {promptGone > 0 ? (
          <LeftoverRow
            label="Run's prompt is gone"
            detail="T3 runs whose starting message was deleted"
            value={promptGone}
            format={format}
            share={share}
            loading={loading}
          />
        ) : null}
        {outside > 0 ? (
          <LeftoverRow
            label="Outside T3 runs"
            detail="terminal sessions, archives, other machines and servers without origins"
            value={outside}
            format={format}
            share={share}
            loading={loading}
            outlined
          />
        ) : null}
      </div>
    </section>
  );
}

function Segment({
  value,
  className,
  style,
}: {
  readonly value: number;
  readonly className?: string;
  readonly style: CSSProperties;
}) {
  if (value <= 0) return null;
  return (
    <span
      className={cn("block h-full min-w-0.5", className)}
      style={{ ...style, flex: `${value} 0 0` }}
    />
  );
}

function Legend({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
      {children}
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
      <i aria-hidden className={cn("inline-block size-2.5 rounded-xs", className)} style={style} />
      {children}
    </span>
  );
}

function LeftoverRow({
  label,
  detail,
  value,
  format,
  share,
  loading,
  outlined = false,
}: {
  readonly label: string;
  readonly detail: string;
  readonly value: number;
  readonly format: (value: number) => string;
  readonly share: (value: number) => string;
  readonly loading: boolean;
  readonly outlined?: boolean;
}) {
  if (value <= 0 && detail === "") return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-6 border-b border-border/50 px-2 py-2.5 text-sm">
      <div className="min-w-0">
        <span className="flex items-center gap-2 text-foreground">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              outlined && "border border-muted-foreground/60",
            )}
            style={outlined ? undefined : { backgroundColor: UNRECORDED_INK }}
          />
          {label}
        </span>
        {detail ? (
          <span className="mt-0.5 block ps-4 text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </div>
      <span className={cn("text-right text-foreground tabular-nums", figureClass(loading))}>
        {format(value)}
      </span>
      <span
        className={cn(
          "hidden w-12 text-right text-muted-foreground tabular-nums sm:block",
          figureClass(loading),
        )}
      >
        {share(value)}
      </span>
    </div>
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}
