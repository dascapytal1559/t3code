import type { EnvironmentId, StoredDecision, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

/** A decision FirstMate needs from the user, with the environment whose FirstMate asked it. */
export interface BridgeDecision {
  readonly environmentId: EnvironmentId;
  /** FirstMate's chat, where a reply goes. */
  readonly replyTo: ThreadId | null;
  readonly decision: StoredDecision;
}

/**
 * Every connected environment's decisions, as the Bridge tab lists them. Each environment's list
 * is subscribed to only while something reads this, which is while a Bridge tab is open.
 */
export const bridgeDecisionsAtom = Atom.make((get): ReadonlyArray<BridgeDecision> => {
  const decisions: BridgeDecision[] = [];
  for (const environmentId of get(environmentServerConfigsAtom).keys()) {
    const state = AsyncResult.getOrElse(
      get(serverEnvironment.decisions({ environmentId, input: {} })),
      () => null,
    );
    if (state === null) continue;
    for (const decision of state.decisions) {
      decisions.push({ environmentId, replyTo: state.replyTo, decision });
    }
  }
  return decisions;
}).pipe(Atom.withLabel("web-bridge-decisions"));
