import type { ScopedThreadRef } from "@t3tools/contracts";
import { isHostPath } from "@t3tools/shared/path";

import type { MarkdownFileLinkMeta } from "./markdown-links";
import { useRightPanelStore } from "./rightPanelStore";

/** The side panel's path for a reference: inside the workspace relative to it, else the host path. */
function fileReferencePanelPath(meta: MarkdownFileLinkMeta): string | null {
  return meta.workspaceRelativePath ?? (isHostPath(meta.filePath) ? meta.filePath : null);
}

/** Fork: chat, the rendered file view and the live editor all open a file reference here. */
export function openFileReference(
  threadRef: ScopedThreadRef,
  meta: MarkdownFileLinkMeta,
  panelPath: string | null = fileReferencePanelPath(meta),
) {
  if (panelPath === null) return;
  const { openFile } = useRightPanelStore.getState();
  if (meta.heading === undefined) openFile(threadRef, panelPath, meta.line);
  else openFile(threadRef, panelPath, meta.line, meta.heading);
}
