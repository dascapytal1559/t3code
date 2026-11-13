import type { DecisionsState, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

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
