import { formatPercent } from "@t3tools/shared/usageFormat";
import { ChevronRightIcon } from "lucide-react";
import { useGT, useLocale, useMessages } from "gt-react";
import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { emphasisColor, emphasisPositions, isTopLeague } from "./usageEmphasis";
import {
  burst,
  fold,
  glide,
  OPEN_SPACE,
  pop,
  reducedMotion,
  ripple,
  SHUT,
  SHUT_AFTER_MS,
  unfold,
  type TreeRow,
} from "./usageMotion";
import { OTHER_WORK_LABEL, type BoxBand, type BoxGroup, type BoxModel } from "./usageSplits";
import { OTHER_WORK } from "@t3tools/shared/usageMerge";

/** A provider row's extras: its mark, and the switch that leaves it out of the totals. */
export interface BoxRowExtras {
  readonly icon?: ReactNode;
  readonly excluded?: boolean;
  readonly onToggle?: () => void;
  readonly excludedLabel?: string;
  readonly toggleLabel?: string;
}

/** Where a folded box was clicked, so its card opens from there. */
export interface BoxOpening {
  readonly id: number;
  /** Across the bar, as a share of its width. */
  readonly clickAt: number;
  /** In the card, in px from its top-left corner. */
  readonly x: number;
  readonly y: number;
}

const valueOf = (band: BoxBand, metric: "cost" | "tokens") =>
  metric === "cost" ? band.costUsd : band.totalTokens;

/** A band under this share of the bar would be a sliver under a pixel; the rows still list it. */
const SLIVER = 0.002;

/** The colour bar: segments meet edge to edge, only the two ends are rounded. */
function ShareBar({
  bands,
  metric,
  barRef,
}: {
  readonly bands: readonly BoxBand[];
  readonly metric: "cost" | "tokens";
  readonly barRef?: React.Ref<HTMLDivElement>;
}) {
  const total = bands.reduce((sum, band) => sum + valueOf(band, metric), 0);
  const shown = bands.filter((band) => total > 0 && valueOf(band, metric) > total * SLIVER);
  const signature = shown.map((band) => `${band.key}:${band.color}`).join("|");
  // The bar cross-fades when its segments change, as the chart's bars do.
  const [previous, setPrevious] = useState({ signature, shown });
  const [ghost, setGhost] = useState<readonly BoxBand[] | null>(null);
  if (previous.signature !== signature) {
    setGhost(reducedMotion() ? null : previous.shown);
    setPrevious({ signature, shown });
  }
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const freshRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fades a one-shot copy of the old segments out over the new ones
  useLayoutEffect(() => {
    if (ghost === null) return;
    freshRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 320,
      easing: "ease-out",
    });
    const fade = ghostRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 320,
      easing: "ease-out",
      fill: "forwards",
    });
    void fade?.finished.then(
      () => setGhost(null),
      () => undefined,
    );
  }, [ghost]);
  const segments = (list: readonly BoxBand[]) =>
    list.map((band, index) => (
      <span
        key={band.key}
        data-segment
        className={cn(
          "block h-full min-w-0",
          index === 0 && "rounded-s-full",
          index === list.length - 1 && "rounded-e-full",
        )}
        style={{ flex: `${valueOf(band, metric)} 1 0`, backgroundColor: band.color }}
      />
    ));
  return (
    <div ref={barRef} aria-hidden className="relative flex h-2">
      <div ref={freshRef} className="contents">
        {segments(shown)}
      </div>
      {ghost === null ? null : (
        <div ref={ghostRef} className="pointer-events-none absolute inset-0 flex">
          {segments(ghost.filter((band) => valueOf(band, metric) > 0))}
        </div>
      )}
    </div>
  );
}

/** What a parent's opening or closing has to finish after React redraws its rows. */
type PendingTree =
  | {
      readonly kind: "open";
      readonly group: string;
      readonly tops: ReadonlyMap<string, number>;
      readonly height: number;
    }
  | { readonly kind: "close"; readonly release: () => void };

/** One breakdown: a bare colour bar until it is the chart's, then a card with its rows. */
export function UsageBreakdownBox({
  model,
  title,
  open,
  metric,
  total,
  format,
  openParents,
  onToggleParent,
  onOpen,
  opening,
  extras,
  loading,
}: {
  readonly model: BoxModel;
  /** A translated title. */
  readonly title: string;
  readonly open: boolean;
  readonly metric: "cost" | "tokens";
  /** The window's total by the metric, for each row's share. */
  readonly total: number;
  readonly format: (value: number) => string;
  readonly openParents: ReadonlySet<string>;
  readonly onToggleParent: (group: string) => void;
  readonly onOpen: (opening: Omit<BoxOpening, "id">) => void;
  readonly opening: BoxOpening | null;
  readonly extras?: Readonly<Record<string, BoxRowExtras>>;
  readonly loading: boolean;
}) {
  const m = useMessages();
  const gt = useGT();
  const locale = useLocale();
  const cardRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef<PendingTree | null>(null);
  const label = (band: BoxBand) => (band.named ? band.label : m(band.label));
  const isOpen = (group: BoxGroup) => openParents.has(group.key) && group.children.length > 0;
  const barBands = open
    ? model.groups.flatMap((group) => (isOpen(group) ? group.children : [group]))
    : model.groups;

  // Only a new opening plays; the model changing under an open card does not.
  const playOpening = useEffectEvent((at: BoxOpening) => {
    const card = cardRef.current;
    const bar = barRef.current;
    if (card === null || reducedMotion()) return;
    pop(card);
    if (bar !== null) ripple(bar, at.clickAt);
    burst(
      card,
      at.x,
      at.y,
      model.groups.map((group) => group.color),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the reward click's one-shot motion on the card that just opened
  useLayoutEffect(() => {
    if (opening !== null) playOpening(opening);
  }, [opening]);

  const rowCells = (rows: HTMLElement, key: string) => [
    ...rows.querySelectorAll<HTMLElement>(`[data-row="${CSS.escape(key)}"]`),
  ];
  const treeRows = (rows: HTMLElement, group: string): readonly TreeRow[] =>
    [...rows.querySelectorAll<HTMLElement>(`[data-tree="${CSS.escape(group)}"]`)].map((gutter) => ({
      trunk: gutter.querySelector<HTMLElement>("[data-trunk]"),
      elbow: gutter.querySelector<HTMLElement>("[data-elbow]"),
      cells: rowCells(rows, gutter.dataset.row ?? ""),
    }));
  const topsOf = (rows: HTMLElement) => {
    const origin = rows.getBoundingClientRect().top;
    return new Map(
      [...rows.querySelectorAll<HTMLElement>("[data-row-start]")].map((cell) => [
        cell.dataset.row ?? "",
        cell.getBoundingClientRect().top - origin,
      ]),
    );
  };

  const toggle = (group: BoxGroup) => {
    const rows = rowsRef.current;
    if (rows === null || reducedMotion()) {
      onToggleParent(group.key);
      return;
    }
    if (!openParents.has(group.key)) {
      pending.current = {
        kind: "open",
        group: group.key,
        tops: topsOf(rows),
        height: rows.offsetHeight,
      };
      onToggleParent(group.key);
      return;
    }
    // Closing: the branches retract and, a moment in, the rows below glide up into the space;
    // React removes the children once both have finished, where the rows already stand.
    const children = new Set(group.children.map((child) => child.key));
    const starts = [...rows.querySelectorAll<HTMLElement>("[data-row-start]")];
    const first = starts.findIndex((cell) => children.has(cell.dataset.row ?? ""));
    const after = starts.findIndex(
      (cell, index) => index > first && !children.has(cell.dataset.row ?? ""),
    );
    const childTop = first < 0 ? 0 : starts[first]!.getBoundingClientRect().top;
    const delta =
      first < 0
        ? 0
        : (after < 0
            ? rows.getBoundingClientRect().bottom
            : starts[after]!.getBoundingClientRect().top) - childTop;
    const timing = { ...SHUT, delay: SHUT_AFTER_MS, fill: "forwards" as const };
    const moving =
      after < 0
        ? []
        : starts.slice(after).flatMap((cell) => rowCells(rows, cell.dataset.row ?? ""));
    const slides = moving.map((cell) =>
      cell.animate([{ transform: "none" }, { transform: `translateY(${-delta}px)` }], timing),
    );
    const shrink = rows.animate(
      [{ height: `${rows.offsetHeight}px` }, { height: `${rows.offsetHeight - delta}px` }],
      timing,
    );
    void Promise.all([
      fold(treeRows(rows, group.key)),
      ...[...slides, shrink].map((a) => a.finished),
    ]).then(
      () => {
        pending.current = {
          kind: "close",
          release: () => {
            for (const animation of [...slides, shrink]) animation.cancel();
          },
        };
        onToggleParent(group.key);
      },
      () => undefined,
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finishes a parent's opening or closing on the rows React just drew
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    const step = pending.current;
    pending.current = null;
    if (rows === null || step === null) return;
    if (step.kind === "close") {
      step.release();
      return;
    }
    const tops = topsOf(rows);
    glide(
      [...step.tops].flatMap(([key, top]) => {
        const now = tops.get(key);
        return now === undefined ? [] : [{ cells: rowCells(rows, key), delta: top - now }];
      }),
      OPEN_SPACE,
    );
    rows.animate(
      [{ height: `${step.height}px` }, { height: `${rows.offsetHeight}px` }],
      OPEN_SPACE,
    );
    unfold(treeRows(rows, step.group));
  });

  if (!open) {
    return (
      <button
        type="button"
        aria-label={title}
        aria-expanded={false}
        className="group/box block w-full cursor-pointer rounded-md py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const clickAt = rect.width === 0 ? 0.5 : (event.clientX - rect.left) / rect.width;
          onOpen({
            clickAt: Math.min(1, Math.max(0, clickAt)),
            x: event.clientX - rect.left,
            y: 14,
          });
        }}
      >
        <span className="block transition-transform duration-200 group-hover/box:scale-y-150 group-active/box:scale-y-50">
          <ShareBar bands={barBands} metric={metric} />
        </span>
      </button>
    );
  }

  const values = model.groups
    .flatMap((group) => [group, ...group.children])
    .map((band) => valueOf(band, metric));
  const positions = emphasisPositions(values);
  const emphasisOf = (band: BoxBand) => positions[values.indexOf(valueOf(band, metric))] ?? 1;
  const figures = cn("transition-opacity", loading && "opacity-40 delay-150");

  const row = (
    band: BoxBand,
    kind: "parent" | "child",
    first: ReactNode,
    name: ReactNode,
    rowExtras: BoxRowExtras | undefined,
  ) => {
    const position = emphasisOf(band);
    const cell = cn(
      kind === "parent" && "mt-1 first:mt-0",
      rowExtras?.excluded === true && "opacity-50 grayscale",
    );
    return (
      <div key={band.key} className="contents">
        <span
          data-row={band.key}
          data-row-start
          className={cn("flex items-center justify-center self-stretch", cell)}
        >
          {first}
        </span>
        <span
          data-row={band.key}
          className={cn(
            "flex min-w-0 items-center gap-1.5 truncate",
            kind === "parent" ? "font-medium text-foreground" : "ps-0.5 text-muted-foreground",
            cell,
          )}
        >
          {name}
        </span>
        <span
          data-row={band.key}
          className={cn(
            "text-end",
            isTopLeague(position) ? "font-semibold" : "font-medium",
            figures,
            cell,
          )}
          style={{ color: emphasisColor(position) }}
        >
          {format(valueOf(band, metric))}
        </span>
        <span data-row={band.key} className={cn("text-end text-muted-foreground", figures, cell)}>
          {rowExtras?.excluded === true
            ? rowExtras.excludedLabel
            : formatPercent(total === 0 ? 0 : valueOf(band, metric) / total)}
        </span>
      </div>
    );
  };

  return (
    <section
      ref={cardRef}
      aria-label={title}
      className="relative flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5"
    >
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <ShareBar bands={barBands} metric={metric} barRef={barRef} />
      <div
        ref={rowsRef}
        className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto_2.75rem] content-start items-center gap-x-2 gap-y-1 text-xs tabular-nums"
      >
        {model.groups.map((group) => {
          const rowExtras = extras?.[group.key];
          const dot = (
            <i
              aria-hidden
              className="block size-2 rounded-xs"
              style={{ backgroundColor: group.color }}
            />
          );
          const opens = group.children.length > 0;
          const expanded = openParents.has(group.key) && opens;
          const name = opens ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggle(group)}
              className="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm outline-none hover:underline hover:decoration-border hover:underline-offset-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span className="truncate">{label(group)}</span>
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3 shrink-0 text-muted-foreground transition-transform duration-300",
                  expanded && "rotate-90",
                )}
              />
            </button>
          ) : rowExtras?.onToggle === undefined ? (
            <span className="truncate">{label(group)}</span>
          ) : (
            <button
              type="button"
              aria-pressed={rowExtras.excluded !== true}
              aria-label={rowExtras.toggleLabel}
              onClick={rowExtras.onToggle}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {rowExtras.icon}
              <span className="truncate">{label(group)}</span>
            </button>
          );
          const shownChildren = expanded
            ? group.children.filter((child) => !group.hidden.has(child.key))
            : [];
          return [
            row(group, "parent", dot, name, rowExtras),
            ...shownChildren.map((child, index) =>
              row(
                child,
                "child",
                // The crew tree from the left nav: a trunk under the parent's dot, and one stroke per
                // child that turns into the row on a rounded corner. Clicking it closes the parent.
                <span
                  aria-hidden
                  data-tree={group.key}
                  data-row={child.key}
                  onClick={() => toggle(group)}
                  className="relative block h-full w-full cursor-pointer [--usage-tree:color-mix(in_srgb,var(--muted-foreground)_40%,var(--card))] hover:[--usage-tree:color-mix(in_srgb,var(--muted-foreground)_80%,var(--card))]"
                >
                  {index === shownChildren.length - 1 ? null : (
                    <span
                      data-trunk
                      className="absolute start-[calc(50%-0.5px)] -top-2 -bottom-1 w-px bg-(--usage-tree)"
                    />
                  )}
                  <span
                    data-elbow
                    className="absolute start-[calc(50%-0.5px)] -end-2 -top-2 bottom-[calc(50%-0.5px)] rounded-es-md border-s border-b border-(--usage-tree)"
                  />
                </span>,
                <>
                  <i
                    aria-hidden
                    className="block size-1.5 shrink-0 rounded-xs"
                    style={{ backgroundColor: child.color }}
                  />
                  <span className="truncate">{label(child)}</span>
                </>,
                undefined,
              ),
            ),
          ];
        })}
      </div>
      {model.spread === undefined || model.spread.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {gt("Spread across these groups: {kinds}", {
            kinds: new Intl.ListFormat(locale, { type: "conjunction" }).format(
              model.spread.map((key) => (key === OTHER_WORK ? m(OTHER_WORK_LABEL) : key)),
            ),
          })}
        </p>
      )}
    </section>
  );
}
