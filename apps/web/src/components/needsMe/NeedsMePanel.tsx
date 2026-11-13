import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelRouting, ScopedThreadRef } from "@t3tools/contracts";

import { bridgeRulesAtom } from "../../state/rules";
import { useServerConfigs } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { BridgeSection } from "./BridgeSection";
import { bridgeSetting } from "./needsMe.logic";
import { ObjectivesSection } from "./ObjectivesSection";
import { pickBridgeRules } from "./rules.logic";
import { RulesSection } from "./RulesSection";

/**
 * The Bridge tab: the user's objectives, FirstMate's model routing table and the user's rules for
 * FirstMate. What FirstMate needs from the user is on the sidebar's cards instead.
 */
export function NeedsMePanel(props: { readonly threadRef: ScopedThreadRef }) {
  const serverConfigs = useServerConfigs();
  const objectives = bridgeSetting(serverConfigs, props.threadRef.environmentId, "objectives");
  const modelRouting = bridgeSetting(serverConfigs, props.threadRef.environmentId, "modelRouting");
  const rules = pickBridgeRules(useAtomValue(bridgeRulesAtom), props.threadRef.environmentId);

  return (
    <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3">
      {objectives === null ? null : (
        <ObjectivesSection objectives={objectives} environmentId={props.threadRef.environmentId} />
      )}
      {modelRouting === null ? null : (
        <ModelRoutingSection
          modelRouting={modelRouting}
          environmentId={props.threadRef.environmentId}
        />
      )}
      {rules === null ? null : (
        <RulesSection environmentId={rules.environmentId} state={rules.state} />
      )}
    </div>
  );
}

/** Read-only: FirstMate sets it over MCP. `.bridge-routing` stacks its rows in a narrow panel. */
function ModelRoutingSection(props: {
  readonly modelRouting: ModelRouting;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <BridgeSection id="model-routing" title="Model routing">
      <ChatMarkdown
        text={props.modelRouting.markdown}
        cwd={undefined}
        environmentId={props.environmentId}
        className="bridge-routing px-2 text-sm text-foreground/80"
      />
    </BridgeSection>
  );
}
