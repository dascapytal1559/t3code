import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

export function shouldReserveContextWindowMeter(input: {
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return input.detailLoading && input.threadStarted && input.providerReportsContextWindow !== false;
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
