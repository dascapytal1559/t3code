import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

/** authLabel names the plan, for drivers whose usage report carries it. */
export type ProviderUsageLimitsReport = ProviderUsageLimitsUpdate & {
  readonly checkedAt: string;
  readonly authLabel?: string;
  /** A full reading replaces sparse windows and clears a previous probe failure. */
  readonly complete?: boolean;
};

/** A limits read on its own; the account fields let a changed sign-in fall back to the full check. */
export interface ProviderUsageLimitsReading {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  /** The account's label as the full check shows it, such as its plan. */
  readonly label?: string | undefined;
}

export interface ManagedServerProvider {
  /** Cached; pass { fresh: true } before executing updates. */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /** True while getSnapshot still returns the placeholder from before the first completed check. */
  readonly isAwaitingFirstCheck?: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly refreshUsage?: Effect.Effect<void, ServerSettingsError>;
  /**
   * The Usage page's refresh: only the limits read, without install, version or model checks.
   * Absent when the driver cannot read limits on its own.
   */
  readonly refreshUsageLimitsOnly?: Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Merge windows by ID and set any authLabel; an update with no window leaves the snapshot untouched. */
  readonly applyUsageLimits: (update: ProviderUsageLimitsReport) => Effect.Effect<void>;
}
