import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RestartRequest } from "@t3tools/contracts";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryRestartRequestAtom } from "../state/server";

/** The restart the environment's server waits for, so a send queues until it happens. */
export function useRestartRequest(environmentId: EnvironmentId): RestartRequest | null {
  const request = useAtomValue(primaryRestartRequestAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  return primaryEnvironmentId === environmentId ? request : null;
}

export function useRestartPending(environmentId: EnvironmentId): boolean {
  return useRestartRequest(environmentId) !== null;
}
