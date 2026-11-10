import type { EnvironmentId, RulesState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

/** One environment's rules, as FirstMate last sent them. */
export interface BridgeRules {
  readonly environmentId: EnvironmentId;
  readonly state: RulesState;
}

/**
 * Every connected environment that has rules. Each environment's list is subscribed to only while
 * something reads this, which is while a Bridge tab is open.
 */
export const bridgeRulesAtom = Atom.make((get): ReadonlyArray<BridgeRules> => {
  const lists: BridgeRules[] = [];
  for (const environmentId of get(environmentServerConfigsAtom).keys()) {
    const state = AsyncResult.getOrElse(
      get(serverEnvironment.rules({ environmentId, input: {} })),
      () => null,
    );
    if (state !== null && state.rules.length > 0) lists.push({ environmentId, state });
  }
  return lists;
}).pipe(Atom.withLabel("web-bridge-rules"));
