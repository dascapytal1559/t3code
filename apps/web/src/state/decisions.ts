import type { DecisionsState, EnvironmentId, StoredDecision, ThreadId } from "@t3tools/contracts";
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
 * Every connected environment's list of FirstMate's items, with the user's actions it has not
 * applied yet. The sidebar reads it, so each environment's list is subscribed to while it runs.
 */
export const decisionListsAtom = Atom.make(
  (
    get,
  ): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly state: DecisionsState }> => {
    const lists = [];
    for (const environmentId of get(environmentServerConfigsAtom).keys()) {
      const state = AsyncResult.getOrElse(
        get(serverEnvironment.decisions({ environmentId, input: {} })),
        () => null,
      );
      if (state !== null) lists.push({ environmentId, state });
    }
    return lists;
  },
).pipe(Atom.withLabel("web-decision-lists"));

/** Every connected environment's decisions, as the Bridge tab lists them. */
export const bridgeDecisionsAtom = Atom.make((get): ReadonlyArray<BridgeDecision> =>
  get(decisionListsAtom).flatMap(({ environmentId, state }) =>
    state.decisions.map((decision) => ({ environmentId, replyTo: state.replyTo, decision })),
  ),
).pipe(Atom.withLabel("web-bridge-decisions"));
