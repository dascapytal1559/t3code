import type { MergedOrigins } from "@t3tools/shared/usageMerge";

export interface OriginAmount {
  readonly costUsd: number;
  readonly totalTokens: number;
}

export type OriginDevice = "phone" | "computer";

/** Usage traced to a device, split by whether you typed it (direct) or an agent it started did (coordinated). */
export type OriginAxes = Record<
  OriginDevice,
  { readonly direct: OriginAmount; readonly coordinated: OriginAmount }
>;

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
  for (const row of origins.rows) {
    if (row.origin !== "phone" && row.origin !== "computer") continue;
    const cell = devices[row.origin];
    for (const entry of row.bases) {
      const side = entry.via === undefined ? "direct" : "coordinated";
      cell[side] = plus(cell[side], entry);
    }
  }
  return devices;
}
