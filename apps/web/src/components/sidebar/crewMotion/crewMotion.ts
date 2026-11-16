// One-shot motion for a crewmate card joining or leaving FirstMate's tree. This file sets the
// stage; unfold.ts is the motion and traceLight.ts the optional light on top. All of it is Web
// Animations: nothing touches React-owned styles, every animation ends by itself, and the rows
// around the card only move by compositor transforms.

import { copyRowForMotion } from "../../Sidebar.motion";
import { createCrewTreeTrunk, crewTreePart } from "../SidebarCrewTree";
import { createCrewEntranceGate } from "./crewMotion.logic";
import * as traceLight from "./traceLight";
import * as unfold from "./unfold";

/** What the motion animates: a crewmate row, or on the way out the copy standing in for it. */
interface CrewRowStage {
  row: HTMLElement;
  card: HTMLElement;
  elbow: HTMLElement | null;
  trunk: HTMLElement | null;
  /** The rows under this one that are on screen, and how far they travel as its space opens or shuts. */
  below: HTMLElement[];
  shift: number;
}

export interface CrewEnterStage extends CrewRowStage {
  /** How long this entrance waits so several at once land one after another. */
  delay: number;
}

export interface CrewExitStage extends CrewRowStage {
  /** The line from the row above down to this one, when that row no longer draws it. */
  bridge: { retract: (timing: KeyframeAnimationOptions) => Animation } | null;
  /** How far the top of this row's line is below FirstMate's card, right now. */
  distanceHome: () => number;
}

interface CrewMotionOptions {
  /** The Trace add-on: an accent light along the line, on top of the motion. */
  traceLight: boolean;
}

const gate = createCrewEntranceGate();

// Rows play in their own layout effects, before the sidebar's, so a crew motion started in a
// commit tells the sidebar's generic list motion to sit that commit out instead of moving rows
// twice. The sidebar only looks when the list's layout changed, hence the reset.
let claimed = false;
function claimListPass() {
  claimed = true;
  queueMicrotask(() => {
    claimed = false;
  });
}
export const crewMotionClaimsListPass = () => claimed;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function onScreen(row: HTMLElement) {
  const rect = row.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= window.innerHeight;
}

/** Where layout puts an element, without the moves it is in the middle of. */
function layoutTop(el: HTMLElement) {
  return el.getBoundingClientRect().top - new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
}

const COPY = "data-crew-motion-copy";
const BRIDGE = "data-crew-motion-bridge";
const isCopy = (el: Element): el is HTMLElement => el.hasAttribute(COPY);

function rowParts(row: HTMLElement) {
  const card = row.querySelector<HTMLElement>(':scope > [role="button"]');
  if (card === null) return null;
  return { row, card, elbow: crewTreePart(row, "elbow"), trunk: crewTreePart(row, "trunk") };
}

/** The next row in the list: copies of leaving rows sit after the rows, out of order. */
function nextRow(el: Element): HTMLElement | null {
  let next = el.nextElementSibling;
  while (next !== null && (next.tagName !== "LI" || isCopy(next))) next = next.nextElementSibling;
  return next as HTMLElement | null;
}

/**
 * What moves when `row` comes or goes: the rows under it that are on screen, the copies of
 * leaving rows under it, and how far. A copy is not in the layout, so it is first put where the
 * layout would have put it (`slotChange`: +1 a slot opened above it, -1 one closed), and from
 * there moves exactly as the rows do.
 */
function spaceBelow(row: HTMLElement, list: HTMLElement, slotChange: 1 | -1) {
  const top = layoutTop(row);
  const next = nextRow(row);
  const shift = next === null ? row.getBoundingClientRect().height : layoutTop(next) - top;
  const below: HTMLElement[] = [];
  const limit = window.innerHeight + shift;
  for (let el = next; el !== null; el = nextRow(el)) {
    if (el.getBoundingClientRect().top > limit) break;
    below.push(el);
  }
  for (const copy of list.children) {
    // Half a pixel: a copy in this very place (this row's own, or the row above's) is not below.
    if (!isCopy(copy) || layoutTop(copy) - top < 0.5) continue;
    copy.style.top = `${Number.parseFloat(copy.style.top) + slotChange * shift}px`;
    below.push(copy);
  }
  return { below, shift };
}

/** Replays what `from` is in the middle of on `to`, from the same moment. */
function handOver(from: Element, to: Element) {
  return from.getAnimations().flatMap((running) => {
    const effect = running.effect;
    if (!(effect instanceof KeyframeEffect)) return [];
    const replay = to.animate(effect.getKeyframes(), {
      ...effect.getTiming(),
      composite: effect.composite,
    });
    replay.currentTime = running.currentTime;
    return [replay];
  });
}

/**
 * An inert copy of a row React is about to remove, placed exactly over it. It carries on with
 * whatever the row was in the middle of: a move from another card leaving above it, or a bridge
 * still retracting from one that left below.
 */
function standIn(row: HTMLElement, list: HTMLElement) {
  const rect = row.getBoundingClientRect();
  const copy = copyRowForMotion(row);
  copy.setAttribute(COPY, "");
  Object.assign(copy.style, {
    position: "absolute",
    top: `${row.offsetTop}px`,
    left: `${row.offsetLeft}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    // The row skips painting outside its own box; the Trace light leaves the copy for home.
    contentVisibility: "visible",
    transform: "none",
    transition: "none",
    pointerEvents: "none",
    zIndex: "0",
  });
  list.append(copy);
  const bridges = row.querySelectorAll(`[${BRIDGE}]`);
  const inherited = [
    ...handOver(row, copy),
    ...Array.from(copy.querySelectorAll(`[${BRIDGE}]`), (bridge, index) =>
      handOver(bridges[index]!, bridge),
    ).flat(),
  ];
  // offsetTop and offsetLeft round to whole pixels; land the copy exactly on the row it replaces.
  const placed = copy.getBoundingClientRect();
  copy.style.top = `${row.offsetTop + rect.top - placed.top}px`;
  copy.style.left = `${row.offsetLeft + rect.left - placed.left}px`;
  return { copy, inherited };
}

/**
 * When the last crewmate leaves, the row above becomes the last one in the same commit and its
 * line stops at its own elbow, which would leave a gap above the departing branch. This gives
 * that row back the trunk it draws while it is a branch, cut off above the corner where its
 * elbow already draws the same line, so the exit can retract it up into the corner.
 */
function bridgeFrom(above: Element | null) {
  const elbow = above === null ? null : crewTreePart(above, "elbow");
  const gutter = elbow?.parentElement;
  if (elbow == null || gutter == null) return null;
  const bridge = createCrewTreeTrunk(gutter.ownerDocument);
  bridge.setAttribute(BRIDGE, "");
  gutter.append(bridge);
  const trunk = bridge.getBoundingClientRect();
  const corner =
    elbow.getBoundingClientRect().bottom -
    (Number.parseFloat(getComputedStyle(elbow).borderBottomLeftRadius) || 0);
  const length = trunk.bottom - corner;
  if (trunk.height <= 0 || length < 0.5) {
    bridge.remove();
    return null;
  }
  const cutOff = `${corner - trunk.top}px`;
  const full = { clipPath: `inset(${cutOff} 0 0 0)` };
  const gone = { clipPath: `inset(${cutOff} 0 ${length}px 0)` };
  bridge.style.clipPath = full.clipPath;
  return {
    retract: (timing: KeyframeAnimationOptions) =>
      bridge.animate([full, gone], { ...timing, fill: "forwards" }),
    remove: () => bridge.remove(),
  };
}

/** FirstMate's card: the coordinator row is the nearest one above that says so. */
function coordinatorCard(row: Element) {
  let above = row.previousElementSibling;
  while (above !== null && !above.hasAttribute("data-crew-coordinator")) {
    above = above.previousElementSibling;
  }
  return above?.querySelector<HTMLElement>(':scope > [role="button"]') ?? null;
}

/** Plays the entrance of a crewmate row that just joined the crew line, once per thread. */
export function playCrewEnter(
  row: HTMLElement,
  thread: { key: string; ageMs: number },
  options: CrewMotionOptions,
) {
  if (!gate.admits(thread.key, thread.ageMs)) return;
  const list = row.parentElement;
  const parts = rowParts(row);
  // Inserted off screen, the list should simply be there when scrolled to.
  if (list === null || parts === null || !onScreen(row)) return;
  if (reducedMotion()) {
    parts.card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "linear" });
    return;
  }
  const stage = {
    ...parts,
    delay: gate.wait(performance.now()),
    ...spaceBelow(row, list, 1),
  };
  claimListPass();
  unfold.enter(stage);
  if (options.traceLight) traceLight.enter(stage);
}

/**
 * Plays the exit of a crewmate row React is about to remove, on a copy of it, and slides the
 * rows below it closed.
 */
export function playCrewExit(row: HTMLElement, options: CrewMotionOptions) {
  const list = row.parentElement;
  if (reducedMotion() || list === null || !onScreen(row)) return;
  const { copy, inherited } = standIn(row, list);
  const parts = rowParts(copy);
  if (parts === null) {
    copy.remove();
    return;
  }
  const home = coordinatorCard(row);
  const bridge = bridgeFrom(row.previousElementSibling);
  const stage: CrewExitStage = {
    ...parts,
    ...spaceBelow(row, list, -1),
    bridge,
    distanceHome: () => (home === null ? 0 : layoutTop(copy) - home.getBoundingClientRect().bottom),
  };
  claimListPass();
  const over = [
    ...inherited.map((animation) => animation.finished),
    ...unfold.exit(stage).map((animation) => animation?.finished),
    options.traceLight ? traceLight.exit(stage) : undefined,
  ];
  void Promise.allSettled(over).then(() => {
    copy.remove();
    bridge?.remove();
  });
}
