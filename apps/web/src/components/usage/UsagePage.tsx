import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Atom } from "effect/reactivity";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageAnnotation,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  CircleAlertIcon,
  ChevronDownIcon,
  InfoIcon,
  MilestoneIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "@t3tools/client-runtime/state/usage-progress";

import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { useUsage, type EnvironmentUsageStatus, type SelectedUsage } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUsdShort,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { formatUsageContractMismatch, usageSourceMessages } from "@t3tools/shared/usageFormatCopy";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Toggle as ToggleButton } from "../ui/toggle";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import {
  UsageChartFrame,
  UsageStackedChart,
  usageChartCaption,
  type ChartSeries,
  type ChartTransition,
} from "./UsageProviderChart";
import {
  BREAKDOWN_ORDER,
  breakdownTitle,
  chartBands,
  deviceBox,
  processBox,
  providerBox,
  shownBreakdowns,
  speedBox,
  typeBox,
  workBox,
  type BoxGroup,
  type BoxModel,
  type UsageBreakdown,
} from "./usageSplits";
import { UsageBreakdownBox, UsageBreakdownBoxSkeleton, type BoxOpening } from "./UsageBreakdownBox";
import { keepStation, reducedMotion, regrow } from "./usageMotion";
import { collectUsageAnnotations, placeUsageAnnotations } from "./usageAnnotations";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  usageChartTitle,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  providersWithUsage,
  rankProvidersByMetric,
  withProviderShown,
} from "./usageProviders";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";

/**
 * The groups a breakdown draws below the centre line of a mirror chart, or null for a stacked one:
 * device and kind of work mirror when they split in two, the larger part above; process keeps
 * direct above and the processes below; type keeps what goes in above and output below.
 */
function lowerGroups(kind: UsageBreakdown, model: BoxModel): readonly BoxGroup[] | null {
  if (kind === "device" || kind === "work") {
    return model.groups.length === 2 ? [model.groups[1]!] : null;
  }
  const below =
    kind === "process"
      ? model.groups.filter((group) => group.key !== "other")
      : kind === "type"
        ? model.groups.filter((group) => group.key === "output")
        : [];
  return below.length > 0 && below.length < model.groups.length ? below : null;
}

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

function usageLoading(
  showingKept: boolean,
  selectedEnvironments: Parameters<typeof usageLoadingState>[0],
  refreshingUsage: boolean,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  if (showingKept) {
    return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
  }
  const state = usageLoadingState(selectedEnvironments, refreshingUsage);
  const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
  return {
    partial: state.everyProvider || providers.size > 0,
    everyProvider: state.everyProvider,
    providers,
  };
}

/** Keep dialog selection outside UsagePage so opening/closing rerenders only its host. */
const selectedUsageModelKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("usage:selected-model-key"),
);

function selectUsageModel(key: string | null): void {
  appAtomRegistry.set(selectedUsageModelKeyAtom, key);
}

function UsageModelDialogHost({
  models,
  onSetPrice,
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialog>[0], "model" | "onSetPrice" | "onClose"> & {
  readonly models: MergedUsage["models"];
  readonly onSetPrice: (model: string) => void;
}) {
  const selectedKey = useAtomValue(selectedUsageModelKeyAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared selected-model atom on unmount
  useEffect(() => () => selectUsageModel(null), []);
  const model =
    selectedKey === null
      ? undefined
      : models.find((candidate) => `${candidate.provider}:${candidate.model}` === selectedKey);
  if (model === undefined) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={model}
      onSetPrice={() => {
        selectUsageModel(null);
        onSetPrice(model.model);
      }}
      onClose={() => selectUsageModel(null)}
    />
  );
}

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const latestPreferences = useRef(preferences);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut
      ? gt("{label} ({shortcut})", { label: m(option.label), shortcut })
      : m(option.label);
  };
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: preferences.windowDays,
    window: makeWindow(
      preferences.windowDays,
      undefined,
      preferences.windowDays === 1 ? "hour" : "day",
    ),
  }));
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const breakdown: UsageBreakdown = preferences.breakdown ?? "provider";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const modalActionsRef = useRef<DialogPrimitive.Root.Actions | null>(null);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const hiddenProviders = new Set(preferences.hiddenProviders);
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing && !showingLimits;
  const showingKept = shown !== null && shown.window !== window;
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );
  const annotations = collectUsageAnnotations(
    selectedEnvironments.map((environment) => environment.summary?.annotations),
  );
  const showAnnotations = preferences.showAnnotations !== false;

  const updatePreferences = (
    patch:
      | Partial<UsagePagePreferences>
      | ((current: UsagePagePreferences) => Partial<UsagePagePreferences>),
  ) => {
    const current = latestPreferences.current;
    const nextPreferences = {
      ...current,
      ...(typeof patch === "function" ? patch(current) : patch),
    };
    latestPreferences.current = nextPreferences;
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    updatePreferences({ windowDays: days });
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric === "limits") setLimitsNow(Date.now());
    updatePreferences({ metric: nextMetric });
  };
  const refreshLimits = (automatic = false) =>
    // Settled so the timestamp still advances when a refresh throws.
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: { usageLimitsOnly: true } }),
              automatic,
            );
          }
        }),
      ),
    ).then((result) => {
      setLimitsNow(Date.now());
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    if (command === "usage.open") {
      event.preventDefault();
      event.stopPropagation();
      modalActionsRef.current?.close();
      return;
    }
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectWindow(periodOption.days);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage metric, period, and close shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits from the server when the connected environment set changes
  useEffect(() => {
    if (showingLimits && connectedLimitsEnvironments) autoRefreshLimits();
  }, [showingLimits, connectedLimitsEnvironments]);

  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const hours =
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime);
  const showChatGptSharing =
    !hiddenProviders.has("codex") &&
    [...presentationsWithProviders].some(
      ([id, presentation]) =>
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
        (presentation.serverConfig?.providers ?? []).some(usesChatGptSharing),
    );

  const windowLabel =
    shownHourly && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? gt("{start} to {end}", {
          start: formatDateTimeShort(shownWindow.sinceTime, shownWindow.timeZone, hour12, locale),
          end: formatDateTimeShort(shownWindow.untilTime, shownWindow.timeZone, hour12, locale),
        })
      : gt("{start} to {end}", {
          start: formatDayShort(shownWindow.sinceDay, locale),
          end: formatDayShort(shownWindow.untilDay, locale),
        });
  const windowOptionLabel = WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label;
  const metricOptionLabel = METRIC_OPTIONS.find((option) => option.value === metric)?.label;
  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-x-3 py-2">
      <WorkspaceBreadcrumb ariaLabel={gt("Usage breadcrumb")} className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>
            <T>Usage</T>
          </h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem className="min-w-10 shrink">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!showingLimits}
            refreshing={refreshingUsage}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageProviderFilter
            hiddenProviders={hiddenProviders}
            onChange={(next) => updatePreferences({ hiddenProviders: next })}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground @7xl/usage-header:block">
          {windowLabel}
        </span>
      ) : null}
      <div className="ms-auto flex shrink-0 items-center">
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? gt("Refresh limits") : gt("Refresh usage")}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
    </div>
  );
  // The period and the metric sit at the top of the content; Limits are always current, so they
  // have no period. Segmented where the content is wide enough, menus below that.
  const viewControls = (
    <div className="@container/usage-controls mb-6">
      <div className="hidden items-center justify-between gap-3 @3xl/usage-controls:flex">
        {showingLimits ? (
          <span />
        ) : (
          <ToggleGroup
            aria-label={gt("Usage period")}
            variant="segmented"
            value={[String(windowDays)]}
            onValueChange={(next) => {
              const value = next[0];
              if (value) selectWindow(Number(value));
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
                {m(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
        <ToggleGroup
          aria-label={gt("Usage metric")}
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
              {m(option.label)}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex items-center justify-between gap-2 @3xl/usage-controls:hidden">
        {showingLimits ? (
          <span />
        ) : (
          <Select value={String(windowDays)} onValueChange={(value) => selectWindow(Number(value))}>
            <SelectTrigger
              aria-label={gt("Usage period")}
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>{windowOptionLabel && m(windowOptionLabel)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem
                  key={option.days}
                  value={String(option.days)}
                  title={shortcutTitle(option)}
                >
                  {m(option.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          <SelectTrigger
            aria-label={gt("Usage metric")}
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{metricOptionLabel && m(metricOptionLabel)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                {m(option.label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );

  return (
    <AppRouteModal label={gt("Usage")} short actionsRef={modalActionsRef}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="@container/usage-header flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          {topbarContent}
          <AppRouteModalClose />
        </header>

        <ScrollArea className="min-h-0 flex-1" observeContent>
          <WorkspacePageContainer width="wide">
            {viewControls}
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? showingLimits
                    ? gt("Connect an environment to see limits.")
                    : gt("Connect an environment to see usage.")
                  : showingLimits
                    ? gt("Select an environment to see limits.")
                    : gt("Select an environment to see usage.")}
              </p>
            ) : showingLimits ? (
              <UsageLimitsSection
                selectedEnvironmentIds={selectedEnvironmentIds}
                hiddenProviders={hiddenProviders}
                now={limitsNow}
              />
            ) : shown === null ? (
              <UsageSkeleton open={breakdown} metric={metric === "tokens" ? "tokens" : "cost"} />
            ) : !canReadDiagnostics ? (
              <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                {selectedEnvironments.map((environment) => (
                  <p key={environment.environmentId}>
                    {selectedEnvironments.length > 1
                      ? gt("{environment}: {error}", {
                          environment: environment.label,
                          error: environment.error,
                        })
                      : environment.error}
                  </p>
                ))}
              </div>
            ) : (
              <UsageOverview
                merged={merged}
                shownWindow={shownWindow}
                hour12={hour12}
                days={days}
                hours={hours}
                showingKept={showingKept}
                metric={metric === "tokens" ? "tokens" : "cost"}
                breakdown={breakdown}
                onBreakdownChange={(next) => updatePreferences({ breakdown: next })}
                openParents={preferences.openParents ?? {}}
                onToggleOpenParent={(kind, group) =>
                  updatePreferences((current) => {
                    const openParents = current.openParents ?? {};
                    const open = new Set(openParents[kind] ?? []);
                    if (open.has(group)) open.delete(group);
                    else open.add(group);
                    return { openParents: { ...openParents, [kind]: [...open] } };
                  })
                }
                selectedEnvironments={selectedEnvironments}
                hiddenProviders={hiddenProviders}
                onProviderShownChange={(provider, shown) =>
                  updatePreferences({
                    hiddenProviders: withProviderShown(hiddenProviders, provider, shown),
                  })
                }
                refreshingUsage={refreshingUsage}
                showChatGptSharing={showChatGptSharing}
                annotations={annotations}
                showAnnotations={showAnnotations}
                onShowAnnotationsChange={(shown) => updatePreferences({ showAnnotations: shown })}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {showingLimits ? null : (
        <UsageModelDialogHost
          models={merged.models}
          environments={selectedEnvironments}
          metric={metric === "tokens" ? "tokens" : "cost"}
          chartWindow={{
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
          onSetPrice={(model) => setPriceDialog({ model })}
        />
      )}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </AppRouteModal>
  );
}

function UsageOverview({
  merged,
  shownWindow,
  hour12,
  days,
  hours,
  showingKept,
  metric,
  breakdown,
  onBreakdownChange,
  openParents,
  onToggleOpenParent,
  selectedEnvironments,
  hiddenProviders,
  onProviderShownChange,
  refreshingUsage,
  showChatGptSharing,
  annotations,
  showAnnotations,
  onShowAnnotationsChange,
}: {
  readonly merged: SelectedUsage;
  readonly shownWindow: UsageSummaryInput;
  readonly hour12: boolean;
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly showingKept: boolean;
  readonly metric: "tokens" | "cost";
  readonly breakdown: UsageBreakdown;
  readonly onBreakdownChange: (breakdown: UsageBreakdown) => void;
  /** Parent rows left open, by box. */
  readonly openParents: Readonly<Record<string, readonly string[]>>;
  readonly onToggleOpenParent: (kind: UsageBreakdown, group: string) => void;
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onProviderShownChange: (provider: UsageProviderKind, shown: boolean) => void;
  readonly refreshingUsage: boolean;
  readonly showChatGptSharing: boolean;
  readonly annotations: readonly UsageAnnotation[];
  readonly showAnnotations: boolean;
  readonly onShowAnnotationsChange: (shown: boolean) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const shownHourly = shownWindow.resolution === "hour";
  const loading = usageLoading(showingKept, selectedEnvironments, refreshingUsage, hiddenProviders);
  // Copy the primitive; JSX reads of loading.partial would merge all derivations into one compiler cache
  // scope.
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    PROVIDER_ORDER.filter((provider) => loading.everyProvider || loading.providers.has(provider)),
  );
  const providersWithData = new Set(providersWithUsage(merged.providers));
  // Only loading.providers excludes hidden providers without data. Filter a fresh array so the compiler can
  // cache independently.
  const activeProviders = [...PROVIDER_ORDER].filter(
    (provider) => providersWithData.has(provider) || loading.providers.has(provider),
  );
  const chartLoadingProviders = new Set(
    activeProviders.filter((provider) => loadingProviders.has(provider)),
  );
  const excludedProviders = new Set(providersWithUsage(merged.excludedProviders));
  const listedProviders = [...PROVIDER_ORDER].filter(
    (provider) => activeProviders.includes(provider) || excludedProviders.has(provider),
  );
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap(
      (environment) =>
        environment.summary?.sources.filter(
          (source) => !hiddenProviders.has(source.fingerprint.provider),
        ) ?? [],
    ),
  );
  // Muted rows rank by what they would have added, so muting one does not move it.
  const rankedProviders = rankProvidersByMetric(
    listedProviders,
    [...merged.providers, ...merged.excludedProviders],
    metric,
  );
  const providerTotals = rankedProviders.map((provider) =>
    (excludedProviders.has(provider) ? merged.excludedProviders : merged.providers).find(
      (entry) => entry.provider === provider,
    ),
  );
  const periodsOf = (hourly: boolean) =>
    new Map(
      (hourly ? merged.hourly : merged.daily).map((entry) => [
        "hourStart" in entry ? entry.hourStart : entry.day,
        entry,
      ]),
    );
  const providerPeriods = periodsOf(shownHourly);
  const models: Record<UsageBreakdown, BoxModel> = {
    provider: providerBox(
      rankedProviders.map((provider, index) => ({
        provider,
        label: PROVIDER_PRESENTATION[provider].label,
        color: PROVIDER_PRESENTATION[provider].color,
        totalTokens: providerTotals[index]?.totalTokens ?? 0,
        costUsd: providerTotals[index]?.costUsd ?? 0,
      })),
      (period, key, by) => {
        const entry = providerPeriods.get(period)?.byProvider.get(key as UsageProviderKind);
        return entry === undefined ? 0 : by === "cost" ? entry.costUsd : entry.totalTokens;
      },
    ),
    device: deviceBox(merged, metric, shownHourly),
    process: processBox(merged, metric, shownHourly),
    work: workBox(merged, metric, shownHourly),
    type: typeBox(merged, metric, shownHourly),
    speed: speedBox(merged, shownHourly),
  };
  const kinds = shownBreakdowns(metric, merged.speedCost.fast + merged.speedCost.ultrafast);
  // A breakdown this view does not show, such as speed in the token view, leaves the chart by provider.
  const split = kinds.includes(breakdown) ? breakdown : "provider";
  const openSetOf = (kind: UsageBreakdown): ReadonlySet<string> => new Set(openParents[kind] ?? []);
  const seriesOf = (kind: UsageBreakdown): readonly ChartSeries[] => {
    const model = models[kind];
    // Each lower group's children draw on its side too.
    const below = lowerGroups(kind, model);
    const lower =
      below === null
        ? null
        : new Set(
            below.flatMap((group) => [group.key, ...group.children.map((child) => child.key)]),
          );
    return chartBands(model, openSetOf(kind))
      .filter(
        (band) => kind !== "provider" || !excludedProviders.has(band.key as UsageProviderKind),
      )
      .map((band) => {
        const provider = kind === "provider" ? (band.key as UsageProviderKind) : null;
        return {
          key: band.key,
          label: band.named ? band.label : m(band.label),
          color: band.color,
          ...(lower?.has(band.key) === true ? { below: true } : {}),
          ...(provider === null
            ? { loading: loadingPartial }
            : {
                loading: chartLoadingProviders.has(provider),
                icon: (
                  <ProviderInstanceIcon
                    driverKind={PROVIDER_PRESENTATION[provider].driverKind}
                    displayName={PROVIDER_PRESENTATION[provider].label}
                    iconClassName="size-3"
                  />
                ),
              }),
        };
      });
  };
  const chartSeries = seriesOf(split);
  const chartValueAt = (period: string, key: string) => models[split].valueAt(period, key, metric);
  const total = metric === "cost" ? merged.costUsd : merged.totalTokens;
  const format =
    metric === "tokens" ? formatTokens : (value: number) => formatUsdShort(value, locale);

  const chartShown = activeProviders.length > 0 || excludedProviders.size === 0;
  const [transition, setTransition] = useState<ChartTransition | null>(null);
  const [opening, setOpening] = useState<{
    readonly kind: UsageBreakdown;
    readonly at: BoxOpening;
  } | null>(null);
  const transitionCount = useRef(0);
  const boxRefs = useRef(new Map<UsageBreakdown, HTMLElement>());
  /** The column as it stood when a folded bar was clicked, until the opened card has drawn. */
  const opened = useRef<{
    readonly kind: UsageBreakdown;
    readonly closed: UsageBreakdown;
    readonly tops: ReadonlyMap<UsageBreakdown, number>;
    readonly barTop: number | null;
    /** The open card's bar, which eases back out to the folded bar's place. */
    readonly closedBar: DOMRect | null;
  } | null>(null);
  const leaving = (kind: ChartTransition["kind"]): ChartTransition => ({
    id: ++transitionCount.current,
    kind,
    series: chartSeries,
    valueAt: chartValueAt,
  });
  const barOf = (kind: UsageBreakdown) =>
    boxRefs.current.get(kind)?.querySelector<HTMLElement>("[data-share-bar]") ?? null;
  const barTopOf = (kind: UsageBreakdown) => barOf(kind)?.getBoundingClientRect().top ?? null;
  const openBox = (kind: UsageBreakdown, at: Omit<BoxOpening, "id">) => {
    opened.current = {
      kind,
      closed: split,
      tops: new Map(
        [...boxRefs.current].map(([box, element]) => [box, element.getBoundingClientRect().top]),
      ),
      barTop: barTopOf(kind),
      closedBar: barOf(split)?.getBoundingClientRect() ?? null,
    };
    const next = leaving("switch");
    if (chartShown) setTransition(next);
    setOpening({ kind, at: { ...at, id: next.id } });
    onBreakdownChange(kind);
  };
  // ↑ and ↓ (by default) step through the cards, round from the last to the first.
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const onStepKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (isCommandPaletteOpen() || isModelPickerOpen()) return;
    const command = resolveUsageShortcut(event, keybindings);
    const step =
      command === "usage.breakdown.previous" ? -1 : command === "usage.breakdown.next" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = kinds[(kinds.indexOf(split) + step + kinds.length) % kinds.length]!;
    const bar = barOf(next)?.getBoundingClientRect();
    openBox(next, {
      clickAt: 0.5,
      x: (bar?.width ?? 0) / 2,
      from: { left: bar?.left ?? 0, width: bar?.width ?? 0 },
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for stepping through the breakdown cards
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onStepKey, true);
    return () => globalThis.window.removeEventListener("keydown", onStepKey, true);
  }, []);
  const toggleParent = (kind: UsageBreakdown, group: string) => {
    if (kind === split && chartShown) setTransition(leaving("split"));
    onToggleOpenParent(kind, group);
  };
  // The clicked bar holds still as its card opens: the opened box, and every box whose place the
  // closing card moved, keep station there; the rest glide to their new places. A moment in, the
  // column starts settling where layout puts it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the boxes from where they stood before a card opened to where layout puts them now
  useLayoutEffect(() => {
    const before = opened.current;
    opened.current = null;
    if (before === null || reducedMotion()) return;
    const barTop = barTopOf(before.kind);
    const hold = before.barTop === null || barTop === null ? 0 : before.barTop - barTop;
    const openedAt = kinds.indexOf(before.kind);
    const closedAt = kinds.indexOf(before.closed);
    // Measured before anything moves: where the folded bar now sits in its box, against where the
    // card's bar sat in it.
    const closedBox = boxRefs.current.get(before.closed);
    const closedBar = barOf(before.closed);
    const closedTop = before.tops.get(before.closed);
    const closedDy =
      before.closedBar === null ||
      closedBox === undefined ||
      closedBar === null ||
      closedTop === undefined
        ? null
        : before.closedBar.top -
          closedTop -
          (closedBar.getBoundingClientRect().top - closedBox.getBoundingClientRect().top);
    kinds.forEach((kind, index) => {
      const element = boxRefs.current.get(kind);
      const top = before.tops.get(kind);
      if (element === undefined || top === undefined) return;
      const start = index === openedAt ? hold : top - element.getBoundingClientRect().top;
      const held = index >= openedAt || (closedAt < index && index < openedAt);
      keepStation(element, start, held ? hold : 0);
    });
    if (before.closedBar !== null && closedBar !== null && closedDy !== null) {
      regrow(closedBar, before.closedBar, closedDy);
    }
  });
  const chartAnnotations = placeUsageAnnotations(
    showAnnotations ? annotations : [],
    shownHourly ? hours : days,
    shownHourly ? "hour" : "day",
    shownWindow.timeZone,
  );
  // The provider box's rows: each provider's mark, and the switch that leaves it out of the totals.
  const providerExtras = Object.fromEntries(
    rankedProviders.map((provider) => {
      const excluded = excludedProviders.has(provider);
      return [
        provider,
        {
          icon: <ProviderMark provider={provider} className="size-3.5" />,
          excluded,
          awaiting: !excluded && loadingProviders.has(provider) && !providersWithData.has(provider),
          excludedLabel: gt("Excluded", { $context: "provider left out of usage totals" }),
          toggleLabel: PROVIDER_PRESENTATION[provider].label,
          onToggle: () => onProviderShownChange(provider, excluded),
        },
      ];
    }),
  );
  const sessionsLabel = gt(
    "{count, plural, one {{formatted} session} other {{formatted} sessions}}",
    { count: merged.sessions, formatted: formatCount(merged.sessions, locale) },
  );

  return (
    <div aria-busy={loadingPartial} className="flex flex-col gap-6">
      {sourceMessages.map((message) => (
        <p key={message} className="mb-4 text-sm text-muted-foreground">
          {message}
        </p>
      ))}
      <UsageOverviewGrid
        open={split}
        kinds={kinds}
        total={
          <>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p
                className={cn(
                  "text-4xl font-semibold text-foreground tabular-nums",
                  figureClass(loadingPartial),
                )}
              >
                {metric === "cost"
                  ? formatUsdShort(merged.costUsd, locale)
                  : formatTokens(merged.totalTokens)}
              </p>
              {metric === "cost" && (
                <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  {gt("API estimate")}
                  {merged.costQuality.unpricedShare > 0 && (
                    <Popover>
                      <PopoverTrigger
                        openOnHover
                        render={<InlineButton tone="muted" />}
                        aria-label={gt("Unpriced usage details")}
                      >
                        <InfoIcon className="size-3" aria-hidden />
                      </PopoverTrigger>
                      <PopoverPopup side="top" tooltipStyle>
                        <T>
                          API estimate excludes{" "}
                          <Var>{formatPercent(merged.costQuality.unpricedShare)}</Var> unpriced
                          records.
                        </T>
                      </PopoverPopup>
                    </Popover>
                  )}
                </p>
              )}
            </div>
            <p
              className={cn(
                "text-xs text-muted-foreground tabular-nums",
                figureClass(loadingPartial),
              )}
            >
              {metric === "cost"
                ? gt(
                    "{count, plural, one {{sessions} session · {tokens} tokens} other {{sessions} sessions · {tokens} tokens}}",
                    {
                      count: merged.sessions,
                      sessions: formatCount(merged.sessions, locale),
                      tokens: formatTokens(merged.totalTokens),
                    },
                  )
                : sessionsLabel}
            </p>
            {showChatGptSharing ? (
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  <T>ChatGPT shared usage</T>
                </span>
                <ChatGptUsageButton size="xs" />
              </div>
            ) : null}
          </>
        }
        chart={
          <>
            <div className="flex min-w-0 items-center gap-1">
              <h2 className="truncate text-sm font-medium text-foreground">
                {usageChartTitle(metric, shownHourly, days.length, m)}
              </h2>
            </div>
            {!chartShown ? (
              <p className="flex h-80 items-center justify-center text-sm text-muted-foreground">
                <T>No activity in this window.</T>
              </p>
            ) : (
              <UsageStackedChart
                series={chartSeries}
                valueAt={chartValueAt}
                caption={usageChartCaption(metric, shownHourly ? "hour" : "day", split)}
                days={days}
                hours={hours}
                metric={metric}
                referenceTime={shownWindow.untilTime}
                resolution={shownHourly ? "hour" : "day"}
                timeZone={shownWindow.timeZone}
                hour12={hour12}
                annotations={chartAnnotations}
                {...(annotations.length === 0
                  ? {}
                  : {
                      annotationToggle: (
                        <ToggleButton
                          aria-label={gt("Chart annotations")}
                          title={
                            showAnnotations
                              ? gt("Hide chart annotations")
                              : gt("Show chart annotations")
                          }
                          pressed={showAnnotations}
                          onPressedChange={onShowAnnotationsChange}
                          size="micro"
                          variant="ghost"
                        >
                          <MilestoneIcon aria-hidden />
                        </ToggleButton>
                      ),
                    })}
                transition={transition}
                onTransitionEnd={(id) =>
                  setTransition((current) => (current?.id === id ? null : current))
                }
              />
            )}
          </>
        }
        boxRef={(kind, element) => {
          if (element === null) boxRefs.current.delete(kind);
          else boxRefs.current.set(kind, element);
        }}
        renderBox={(kind) => (
          <UsageBreakdownBox
            model={models[kind]}
            title={m(breakdownTitle(metric, kind))}
            open={kind === split}
            metric={metric}
            total={total}
            format={format}
            openParents={openSetOf(kind)}
            onToggleParent={(group) => toggleParent(kind, group)}
            onOpen={(at) => openBox(kind, at)}
            opening={opening?.kind === kind ? opening.at : null}
            loading={loadingPartial}
            {...(kind === "provider" ? { extras: providerExtras } : {})}
            {...(kind === "speed" && merged.speedCost.premium > 0
              ? { footer: <SpeedPremium premiumUsd={merged.speedCost.premium} /> }
              : {})}
          />
        )}
      />
    </div>
  );
}

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const gt = useGT();
  const m = useMessages();
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {gt("{environment}: {error}", {
            environment: environment.label,
            error: environment.error,
          })}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch, m)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          {gt("Counted once across environments sharing a transcript directory: {sources}", {
            sources: duplicateSources.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onOpenModelPrices: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? gt("All environments")
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : gt("{count, plural, one {{count} environments} other {{count} environments}}", {
          count: selectedEnvironments.length,
        });
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label={gt("Some environments could not report usage")}
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-60 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          <T>All environments</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(environment, refreshing);
          const status =
            environment.error !== null
              ? gt("Unavailable")
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? gt("Update required")
                : !environment.isConnected
                  ? gt("Connecting…")
                  : progress.phase === "loading"
                    ? gt("Scanning…")
                    : progress.phase === "stale"
                      ? gt("Refreshing…")
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel, m)
                        : gt("Ready", { $context: "environment usage status" });
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>No environments connected.</T>
          </p>
        ) : null}
        {showUsageStatus && isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>Totals are partial while selected environments scan.</T>
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onOpenModelPrices}>
          <SlidersHorizontalIcon aria-hidden />
          <T>Model prices</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const gt = useGT();
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? gt("All providers")
      : visible.length === 0
        ? gt("No providers")
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : gt("{count, plural, one {{count} providers} other {{count} providers}}", {
              count: visible.length,
            });

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-provider min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
        >
          <T>All providers</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {PROVIDER_ORDER.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={!hiddenProviders.has(provider)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              onChange(withProviderShown(hiddenProviders, provider, checked))
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark provider={provider} className="size-3.5" />
              <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Chart left over 8 of 12 columns, the total and the breakdown boxes right over 4, 40px apart.
 * Below lg it is one column: the total, the chart, then the boxes. The total's row keeps its own
 * height, so the boxes start under it whichever card is open. The skeleton draws in it too.
 */
function UsageOverviewGrid({
  total,
  chart,
  open,
  kinds,
  renderBox,
  boxRef,
}: {
  readonly total: ReactNode;
  readonly chart: ReactNode;
  readonly open: UsageBreakdown;
  readonly kinds: readonly UsageBreakdown[];
  readonly renderBox: (kind: UsageBreakdown) => ReactNode;
  readonly boxRef?: (kind: UsageBreakdown, element: HTMLElement | null) => void;
}) {
  return (
    <section className="grid items-start gap-x-6 gap-y-5 lg:grid-cols-12 lg:grid-rows-[auto_1fr]">
      <div className="flex min-w-0 flex-col gap-1 lg:col-span-4 lg:col-start-9 lg:row-start-1">
        {total}
      </div>
      <div className="flex min-w-0 flex-col gap-3 lg:col-span-8 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:me-4">
        {chart}
      </div>
      <div className="flex min-w-0 flex-col gap-1 lg:col-span-4 lg:col-start-9 lg:row-start-2">
        {kinds.map((kind) => (
          <div
            key={kind}
            // The open card sits as far from the bars around it as the bars sit from each other.
            className={kind === open ? "my-2.75 first:mt-0 last:mb-0" : undefined}
            ref={boxRef === undefined ? undefined : (element) => boxRef(kind, element)}
          >
            {renderBox(kind)}
          </div>
        ))}
      </div>
    </section>
  );
}

function UsageSkeleton({
  open,
  metric,
}: {
  readonly open: UsageBreakdown;
  readonly metric: "tokens" | "cost";
}) {
  const locale = useLocale();
  // A typical widest tick: the real labels are unknown until the data arrives.
  const axisLabel = metric === "tokens" ? formatTokens(4e9) : formatUsd(1000, locale);
  return (
    <UsageOverviewGrid
      open={open}
      // Whether speed shows is unknown until usage arrives; the skeleton leaves it out unless open.
      kinds={BREAKDOWN_ORDER.filter((kind) => kind !== "speed" || kind === open)}
      total={
        <>
          <span className="flex h-10 items-center">
            <Skeleton className="h-8 w-32" />
          </span>
          <span className="flex h-4 items-center">
            <Skeleton className="h-3 w-52" />
          </span>
        </>
      }
      chart={
        <>
          <span className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-36" />
          </span>
          <UsageChartFrame
            plot={<Skeleton shape="card" className="col-span-2 col-start-1 row-start-1" />}
            yAxis={
              <span
                aria-hidden
                className="invisible col-start-2 row-start-1 text-3xs whitespace-nowrap tabular-nums"
              >
                {axisLabel}
              </span>
            }
            xAxis={
              <span className="col-start-1 row-start-2 flex h-4 items-center">
                <Skeleton className="h-2.5 w-full" />
              </span>
            }
          />
        </>
      }
      renderBox={(kind) => <UsageBreakdownBoxSkeleton open={kind === open} />}
    />
  );
}
