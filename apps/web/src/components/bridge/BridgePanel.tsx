import type { EnvironmentId, ModelRouting, ScopedThreadRef } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { BridgeSection } from "./BridgeSection";
import { bridgeSetting } from "./bridge.logic";
import { ObjectivesSection } from "./ObjectivesSection";

/** The Bridge tab: the user's objectives and FirstMate's model routing table, both read-only. */
export function BridgePanel(props: { readonly threadRef: ScopedThreadRef }) {
  const serverConfigs = useServerConfigs();
  const objectives = bridgeSetting(serverConfigs, props.threadRef.environmentId, "objectives");
  const modelRouting = bridgeSetting(serverConfigs, props.threadRef.environmentId, "modelRouting");

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
