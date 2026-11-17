import type { Citation } from "@t3tools/contracts";
import { createContext } from "react";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

/** Puts a citation in the composer of the thread the side panel belongs to. */
export type CiteInComposer = (
  citation: Citation,
  sourceAnchor: AssistantCitationSourceAnchor,
) => boolean;

export const CiteInComposerContext = createContext<CiteInComposer | null>(null);
