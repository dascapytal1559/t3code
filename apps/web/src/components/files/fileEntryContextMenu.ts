import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { toastManager } from "~/components/ui/toast";
import type { ComposerHandleRef } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { isAbsolutePath } from "~/terminal-links";

import { workspaceAbsolutePath } from "./filePath";

type FileEntryContextMenuItemId = "copy-mention" | "copy-absolute-path" | "add-to-chat";

interface ShowFileEntryContextMenuOptions {
  /** Workspace root the entry belongs to. */
  readonly cwd: string;
  /**
   * Entry path as the workspace addresses it: relative to `cwd`, `""` for the
   * workspace root, or an absolute host path for files outside the workspace.
   */
  readonly path: string;
  readonly composerRef: ComposerHandleRef | null;
  readonly position: { x: number; y: number };
}

async function copyWithToast(title: string, value: string): Promise<void> {
  try {
    await writeTextToClipboard(value);
    toastManager.add({ type: "success", title, description: value });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Failed to copy ${title.toLowerCase()}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

/**
 * Right-click menu shared by the file explorer rows and the preview
 * breadcrumbs. Mentions only make sense for entries inside the workspace, so
 * the workspace root and host paths outside it get the absolute path alone.
 */
export async function showFileEntryContextMenu(
  options: ShowFileEntryContextMenuOptions,
): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const path = options.path.replace(/\/$/, "");
  const mentionable = path !== "" && !isAbsolutePath(path);
  const absolutePath = workspaceAbsolutePath(options.cwd, path);
  const clicked = await api.contextMenu.show<FileEntryContextMenuItemId>(
    [
      ...(mentionable ? [{ id: "copy-mention" as const, label: "Copy mention" }] : []),
      { id: "copy-absolute-path", label: "Copy absolute path" },
      ...(mentionable ? [{ id: "add-to-chat" as const, label: "Add to chat" }] : []),
    ],
    options.position,
  );
  if (clicked === "copy-mention") {
    await copyWithToast("Mention copied", serializeComposerFileLink(path));
    return;
  }
  if (clicked === "copy-absolute-path") {
    await copyWithToast("Absolute path copied", absolutePath);
    return;
  }
  if (clicked === "add-to-chat") {
    const composer = options.composerRef?.current;
    if (!composer) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "Open a chat for this project and try again.",
      });
      return;
    }
    const inserted = composer.insertTextAtEnd(`${serializeComposerFileLink(path)} `, {
      ensureLeadingBoundary: true,
    });
    if (!inserted) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The chat isn't ready to accept input right now.",
      });
    }
  }
}
