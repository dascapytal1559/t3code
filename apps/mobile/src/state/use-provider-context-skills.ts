import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { useProviderContextSkills as useProviderContextSkillsQuery } from "../state/queries";

export function useProviderContextSkills(target: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
}) {
  return useProviderContextSkillsQuery(target);
}
