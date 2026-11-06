import { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  useLocalStorage,
  writeLocalStorageValue,
} from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90, 180, 365]),
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

/** Notifies `useUsageHiddenProviders` readers in this tab too. */
export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  writeLocalStorageValue(STORAGE_KEY, preferences, DEFAULT_PREFERENCES, UsagePagePreferencesSchema);
}

export function useUsageHiddenProviders(): ReadonlySet<UsageProviderKind> {
  const [preferences] = useLocalStorage(
    STORAGE_KEY,
    DEFAULT_PREFERENCES,
    UsagePagePreferencesSchema,
  );
  return new Set(preferences.hiddenProviders);
}
