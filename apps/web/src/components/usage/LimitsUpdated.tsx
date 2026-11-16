import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";

/** How long ago limits were read, such as "3m ago"; checks pause while no window is in front. */
export function useLimitsAge(checkedAt: string | null): string | null {
  const age = useRelativeTimeState(checkedAt);
  if (age.status !== "relative") return null;
  return age.suffix ? `${age.value} ${age.suffix}` : age.value;
}

/** The stalest reading, so a pooled view never looks fresher than its oldest account. */
export function oldestCheckedAt(
  limits: ReadonlyArray<{ readonly checkedAt: string }>,
): string | null {
  return limits.reduce<string | null>(
    (oldest, { checkedAt }) =>
      oldest === null || Date.parse(checkedAt) < Date.parse(oldest) ? checkedAt : oldest,
    null,
  );
}

export function LimitsUpdated({
  checkedAt,
  className,
}: {
  readonly checkedAt: string | null;
  readonly className?: string;
}) {
  const age = useLimitsAge(checkedAt);
  return age ? <span className={className}>Updated {age}</span> : null;
}
