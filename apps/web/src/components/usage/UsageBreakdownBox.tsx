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
  openSpace,
  reducedMotion,
  reveal,
  ripple,
  SHUT,
  SHUT_AFTER_MS,
  unfold,
  type TreeRow,
} from "./usageMotion";
import {
  OTHER_WORK_LABEL,
  opensIntoChildren,
  type BoxBand,
  type BoxGroup,
  type BoxModel,
} from "./usageSplits";
import { OTHER_WORK } from "@t3tools/shared/usageMerge";

/** A provider row's extras: its mark, and the switch that leaves it out of the totals. */
export interface BoxRowExtras {
  readonly icon?: ReactNode;
  readonly excluded?: boolean;
  readonly awaiting?: boolean;
  readonly onToggle?: () => void;
  readonly excludedLabel?: string;
  readonly toggleLabel?: string;
}

/** Where a folded box was clicked, so its card opens from there. */
export interface BoxOpening {
  readonly id: number;
  /** Across the bar, as a share of its width. */
  readonly clickAt: number;
  /** In the card, in px from its left edge. */
  readonly x: number;
  /** Where the folded bar stood, in viewport px, so the card's bar grows out of it. */
  readonly from: { readonly left: number; readonly width: number };
}

const valueOf = (band: BoxBand, metric: "cost" | "tokens") =>
  metric === "cost" ? band.costUsd : band.totalTokens;

/** A band under this share of the bar would be a sliver under a pixel; the rows still list it. */
const SLIVER = 0.002;

/** The colour bar: segments meet edge to edge, and the bar clips them to its rounded ends. */
function ShareBar({
  bands,
  metric,
}: {
  readonly bands: readonly BoxBand[];
  readonly metric: "cost" | "tokens";
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
  const barRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fades a one-shot copy of the old segments out over the new ones
  useLayoutEffect(() => {
    if (ghost === null) return;
    for (const segment of barRef.current?.querySelectorAll(":scope > [data-segment]") ?? []) {
      segment.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
    }
    const fade = ghostRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 320,
      easing: "ease-out",
      fill: "forwards",
    });
    void fade?.finished.then(
      () => setGhost((current) => (current === ghost ? null : current)),
      () => undefined,
    );
  }, [ghost]);
  const segments = (list: readonly BoxBand[]) =>
    list.map((band) => (
      <span
        key={band.key}
        data-segment
        className="block h-full min-w-0"
        style={{ flex: `${valueOf(band, metric)} 1 0`, backgroundColor: band.color }}
      />
    ));
  return (
    <div
      ref={barRef}
      data-share-bar
      aria-hidden
      className="relative flex h-2 overflow-hidden rounded-xs"
    >
      {segments(shown)}
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
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef<PendingTree | null>(null);
  const closing = useRef(new Set<string>());
  const label = (band: BoxBand) => (band.named ? band.label : m(band.label));
  const isOpen = (group: BoxGroup) => openParents.has(group.key) && opensIntoChildren(group);
  const barBands = model.groups
    .filter((group) => extras?.[group.key]?.excluded !== true)
    .flatMap((group) => (open && isOpen(group) ? group.children : [group]));

  // Only a new opening plays; the model changing under an open card does not.
  const playOpening = useEffectEvent((at: BoxOpening) => {
    const card = cardRef.current;
    if (card === null || reducedMotion()) return;
    const bar = card.querySelector<HTMLElement>("[data-share-bar]");
    if (bar === null) return;
    reveal(card, bar, at.from);
    ripple(bar, at.clickAt);
    burst(
      card,
      at.x,
      bar.offsetTop + bar.offsetHeight / 2,
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
      cells: rowCells(rows, gutter.parentElement?.dataset.row ?? ""),
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

  const finishClose = useEffectEvent((group: string) => onToggleParent(group));
  const toggle = (group: BoxGroup) => {
    if (closing.current.has(group.key)) return;
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
    const last = (after < 0 ? starts.length : after) - 1;
    const delta =
      first < 0
        ? 0
        : starts[last]!.getBoundingClientRect().bottom -
          starts[first]!.getBoundingClientRect().top +
          Number.parseFloat(getComputedStyle(rows).rowGap);
    closing.current.add(group.key);
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
        closing.current.delete(group.key);
        pending.current = {
          kind: "close",
          release: () => {
            for (const animation of [...slides, shrink]) animation.cancel();
          },
        };
        finishClose(group.key);
      },
      () => {
        closing.current.delete(group.key);
      },
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
    const children = treeRows(rows, step.group);
    const space = openSpace(children.length);
    glide(
      [...step.tops].flatMap(([key, top]) => {
        const now = tops.get(key);
        return now === undefined ? [] : [{ cells: rowCells(rows, key), delta: top - now }];
      }),
      space,
    );
    rows.animate([{ height: `${step.height}px` }, { height: `${rows.offsetHeight}px` }], space);
    unfold(children);
  });

  if (!open) {
    return (
      <button
        type="button"
        aria-label={title}
        aria-expanded={false}
        className="group/box block w-full cursor-pointer rounded-md py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const bar =
            event.currentTarget.querySelector("[data-share-bar]")?.getBoundingClientRect() ?? rect;
          const keyboard = event.detail === 0;
          const clickAt =
            keyboard || rect.width === 0 ? 0.5 : (event.clientX - rect.left) / rect.width;
          onOpen({
            clickAt: Math.min(1, Math.max(0, clickAt)),
            x: keyboard ? rect.width / 2 : event.clientX - rect.left,
            from: { left: bar.left, width: bar.width },
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
    kind: "first" | "parent" | "child",
    first: ReactNode,
    name: ReactNode,
    rowExtras: BoxRowExtras | undefined,
  ) => {
    const position = emphasisOf(band);
    const cell = cn(
      // Each row sits in a `contents` wrapper, so `first:` would match every row's first cell.
      kind === "parent" && "mt-1",
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
            kind === "child" ? "ps-0.5 text-muted-foreground" : "font-medium text-foreground",
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
          {rowExtras?.awaiting === true ? "-" : format(valueOf(band, metric))}
        </span>
        <span data-row={band.key} className={cn("text-end text-muted-foreground", figures, cell)}>
          {rowExtras?.excluded === true
            ? rowExtras.excludedLabel
            : rowExtras?.awaiting === true
              ? null
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
      <ShareBar bands={barBands} metric={metric} />
      <div
        ref={rowsRef}
        className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto_2.75rem] content-start items-center gap-x-2 gap-y-1 text-xs tabular-nums"
      >
        {model.groups.map((group, groupIndex) => {
          const rowExtras = extras?.[group.key];
          const dot = (
            <i
              aria-hidden
              className="block size-2 rounded-xs"
              style={{ backgroundColor: group.color }}
            />
          );
          const opens = opensIntoChildren(group);
          const expanded = isOpen(group);
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
            row(group, groupIndex === 0 ? "first" : "parent", dot, name, rowExtras),
            ...shownChildren.map((child, index) =>
              row(
                child,
                "child",
                // The crew tree from the left nav: a trunk under the parent's dot, and one stroke per
                // child that turns into the row on a rounded corner. Clicking it closes the parent.
                <span
                  aria-hidden
                  data-tree={group.key}
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
