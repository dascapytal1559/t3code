import type { MergedOrigins, OriginBasisTotals, OriginTotals } from "@t3tools/shared/usageMerge";

export interface OriginAmount {
  readonly prompts: number;
  readonly costUsd: number;
  readonly totalTokens: number;
}

export type OriginDevice = "phone" | "computer";

/** Why a T3 run's prompt names no device. */
export type UnrecordedReason =
  | "crew"
  | "notification"
  | "agent"
  | "unstamped"
  | "server"
  | "stampedUnknown";

export interface UnrecordedSide extends OriginAmount {
  /** Largest first; only reasons with prompts or usage. */
  readonly reasons: readonly (OriginAmount & { readonly reason: UnrecordedReason })[];
}

/** The By origin figures on two axes: which device, and whether you typed it (direct) or an agent did (coordinated). */
export interface OriginAxes {
  readonly devices: Record<
    OriginDevice,
    { readonly direct: OriginAmount; readonly coordinated: OriginAmount }
  >;
  readonly unrecorded: { readonly direct: UnrecordedSide; readonly coordinated: UnrecordedSide };
  /** T3 runs whose starting message is gone: neither axis is known. */
  readonly promptGone: OriginAmount;
  readonly outside: Omit<OriginAmount, "prompts">;
}

interface Placement {
  readonly side: "direct" | "coordinated";
  readonly device: OriginDevice | null;
  readonly reason: UnrecordedReason | null;
}

/** Every message records who sent it, so directness is known even where the device is not. */
function place(
  origin: OriginTotals["origin"],
  { basis, via }: OriginBasisTotals,
): Placement | null {
  switch (origin) {
    case "phone":
    case "computer":
      return { side: via === undefined ? "direct" : "coordinated", device: origin, reason: null };
    case "agent":
    case "crew":
      return {
        side: "coordinated",
        device: null,
        reason: basis === "notification" ? "notification" : origin === "crew" ? "crew" : "agent",
      };
    case "unknown":
      if (basis === "noPrompt") return null;
      return {
        side: "direct",
        device: null,
        reason: basis === "server" ? "server" : basis === "stamp" ? "stampedUnknown" : "unstamped",
      };
  }
}

const EMPTY: OriginAmount = { prompts: 0, costUsd: 0, totalTokens: 0 };
const plus = (a: OriginAmount, b: OriginAmount): OriginAmount => ({
  prompts: a.prompts + b.prompts,
  costUsd: a.costUsd + b.costUsd,
  totalTokens: a.totalTokens + b.totalTokens,
});

export function originAxes(origins: MergedOrigins): OriginAxes {
  const devices = {
    phone: { direct: EMPTY, coordinated: EMPTY },
    computer: { direct: EMPTY, coordinated: EMPTY },
  };
  const reasons = {
    direct: new Map<UnrecordedReason, OriginAmount>(),
    coordinated: new Map<UnrecordedReason, OriginAmount>(),
  };
  let promptGone = EMPTY;
  for (const row of origins.rows) {
    for (const entry of row.bases) {
      const amount = {
        prompts: entry.prompts,
        costUsd: entry.costUsd,
        totalTokens: entry.totalTokens,
      };
      const placement = place(row.origin, entry);
      if (placement === null) {
        promptGone = plus(promptGone, amount);
      } else if (placement.device !== null) {
        const cell = devices[placement.device];
        cell[placement.side] = plus(cell[placement.side], amount);
      } else if (placement.reason !== null) {
        const byReason = reasons[placement.side];
        byReason.set(placement.reason, plus(byReason.get(placement.reason) ?? EMPTY, amount));
      }
    }
  }
  const side = (byReason: ReadonlyMap<UnrecordedReason, OriginAmount>): UnrecordedSide => {
    const list = [...byReason]
      .map(([reason, amount]) => ({ reason, ...amount }))
      .filter((entry) => entry.prompts > 0 || entry.totalTokens > 0 || entry.costUsd > 0)
      .toSorted((a, b) => b.totalTokens - a.totalTokens || b.prompts - a.prompts);
    return { ...list.reduce<OriginAmount>(plus, EMPTY), reasons: list };
  };
  return {
    devices,
    unrecorded: { direct: side(reasons.direct), coordinated: side(reasons.coordinated) },
    promptGone,
    outside: { costUsd: origins.unlinkedCostUsd, totalTokens: origins.unlinkedTokens },
  };
}
