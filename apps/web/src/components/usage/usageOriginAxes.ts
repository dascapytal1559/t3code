import type { MergedOrigins } from "@t3tools/shared/usageMerge";

export interface OriginAmount {
  readonly costUsd: number;
  readonly totalTokens: number;
}

export type OriginDevice = "phone" | "computer";

/**
 * The bar's categories: each device split by whether you typed it (direct) or an agent it started
 * did (coordinated), then usage with no recorded parent. History that can never trace stays out.
 */
export interface OriginAxes {
  readonly phone: { readonly direct: OriginAmount; readonly coordinated: OriginAmount };
  readonly computer: { readonly direct: OriginAmount; readonly coordinated: OriginAmount };
  readonly unknown: OriginAmount;
  readonly beforeOrigins: OriginAmount;
  readonly archive: OriginAmount;
}

const EMPTY: OriginAmount = { costUsd: 0, totalTokens: 0 };
const plus = (a: OriginAmount, b: OriginAmount): OriginAmount => ({
  costUsd: a.costUsd + b.costUsd,
  totalTokens: a.totalTokens + b.totalTokens,
});

export function originAxes(origins: MergedOrigins): OriginAxes {
  const devices = {
    phone: { direct: EMPTY, coordinated: EMPTY },
    computer: { direct: EMPTY, coordinated: EMPTY },
  };
  let unknown = EMPTY;
  let beforeOrigins = EMPTY;
  let archive = EMPTY;
  for (const row of origins.rows) {
    for (const entry of row.bases) {
      // Servers before Unknown had its own category sent this as computer `default`.
      if (entry.basis === "default") unknown = plus(unknown, entry);
      else if (row.origin === "phone" || row.origin === "computer") {
        const cell = devices[row.origin];
        const side = entry.via === undefined ? "direct" : "coordinated";
        cell[side] = plus(cell[side], entry);
      } else if (entry.basis === "beforeOrigins") beforeOrigins = plus(beforeOrigins, entry);
      else if (entry.basis === "archive") archive = plus(archive, entry);
    }
  }
  return { ...devices, unknown, beforeOrigins, archive };
}
