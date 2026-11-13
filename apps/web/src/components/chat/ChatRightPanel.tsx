import { type Ref, useImperativeHandle } from "react";

import {
  type PanelWidthHandle,
  usePreviewPanelInlineSize,
} from "../../hooks/usePreviewPanelInlineSize";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
  /** Fork: lets the desktop window take off the panel's width as it is when it closes. */
  readonly panelWidthRef?: Ref<PanelWidthHandle>;
};

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet,
    workspaceLayoutElement,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    panelWidthRef,
    ...tabs
  } = props;
  const open = tabs.open === true;
  const inlineSize = usePreviewPanelInlineSize({
    enabled: open && !sheet && !maximized,
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  const { keepPanelWidth } = inlineSize;
  useImperativeHandle(panelWidthRef, () => ({ keepPanelWidth }), [keepPanelWidth]);
  if (!sheet) {
    return <RightPanelTabs {...tabs} mode="inline" maximized={maximized} inlineSize={inlineSize} />;
  }
  return (
    <RightPanelSheet
      animationDurationMs={sheetAnimationDurationMs}
      open={tabs.open === true}
      onClose={onCloseSheet}
    >
      <RightPanelTabs
        {...tabs}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={layoutControls}
      />
    </RightPanelSheet>
  );
}
