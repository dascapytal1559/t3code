import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryRestartRequestAtom } from "../state/server";

/** The environment's server waits to restart, so a send queues until it does. */
export function useRestartPending(environmentId: EnvironmentId): boolean {
  const request = useAtomValue(primaryRestartRequestAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  return request !== null && primaryEnvironmentId === environmentId;
}
