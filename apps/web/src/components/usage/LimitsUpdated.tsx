import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react";

import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";

/** A server's `checkedAt` on this client's clock, which ages here are measured against. */
export function onClientClock(checkedAt: string, environmentId: EnvironmentId | null): string {
  const serverMs = Date.parse(checkedAt);
  if (environmentId === null || Number.isNaN(serverMs)) return checkedAt;
  return new Date(serverMs - toServerClock(environmentId, 0)).toISOString();
}

/** How long ago limits were read, such as "3m ago"; checks pause while no window is in front. */
export function useLimitsAge(
  checkedAt: string | null,
  environmentId: EnvironmentId | null,
): string | null {
  const age = useRelativeTimeState(
    checkedAt === null ? null : onClientClock(checkedAt, environmentId),
  );
  return age.status === "relative" ? age.label : null;
}

/** The stalest reading on this client's clock, so a pooled view never looks fresher than its oldest account. */
export function oldestCheckedAt(accounts: ReadonlyArray<LimitAccount>): string | null {
  return accounts.reduce<string | null>((oldest, account) => {
    if (account.limits.unavailable) return oldest;
    const checkedAt = onClientClock(account.limits.checkedAt, account.checkedBy);
    return oldest === null || Date.parse(checkedAt) < Date.parse(oldest) ? checkedAt : oldest;
  }, null);
}

export function LimitsUpdated({
  checkedAt,
  environmentId,
  className,
}: {
  readonly checkedAt: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly className?: string;
}) {
  const gt = useGT();
  const age = useLimitsAge(checkedAt, environmentId);
  return age ? <span className={className}>{gt("Updated {age}", { age })}</span> : null;
}
