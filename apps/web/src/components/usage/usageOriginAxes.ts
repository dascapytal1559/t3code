import type { MergedOrigins } from "@t3tools/shared/usageMerge";

export interface OriginAmount {
  readonly costUsd: number;
  readonly totalTokens: number;
}

export type OriginDevice = "phone" | "computer";

/** The bar's categories: each device split by whether you typed it (direct) or an agent it started did (coordinated). */
export interface OriginAxes {
  readonly phone: { readonly direct: OriginAmount; readonly coordinated: OriginAmount };
  readonly computer: { readonly direct: OriginAmount; readonly coordinated: OriginAmount };
}

const EMPTY: OriginAmount = { costUsd: 0, totalTokens: 0 };
const plus = (a: OriginAmount, b: OriginAmount): OriginAmount => ({
  costUsd: a.costUsd + b.costUsd,
  totalTokens: a.totalTokens + b.totalTokens,
});

/**
 * Usage with no phone evidence counts to the computer, including the agent, crew and unknown rows
 * older servers send. Records in no origin row (unlinked usage) stay out.
 */
export function originAxes(origins: MergedOrigins): OriginAxes {
  const devices = {
    phone: { direct: EMPTY, coordinated: EMPTY },
    computer: { direct: EMPTY, coordinated: EMPTY },
  };
  for (const row of origins.rows) {
    const cell = devices[row.origin === "phone" ? "phone" : "computer"];
    const sentByAgent = row.origin === "agent" || row.origin === "crew";
    for (const entry of row.bases) {
      const side = entry.via === undefined && !sentByAgent ? "direct" : "coordinated";
      cell[side] = plus(cell[side], entry);
    }
  }
  return devices;
}
