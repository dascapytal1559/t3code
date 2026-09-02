import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useServerConfigs } from "~/state/entities";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { useProjectEntriesQuery } from "./projectFilesQueryState";
import { useLazyFileTree } from "./useLazyFileTree";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
  /* The tree right-aligns the decoration lane (flex: 1, justify flex-end);
     pin it to hug the row name instead so the symlink arrow reads as part
     of the label. */
  div[data-item-section='decoration'] { opacity: 0.55; flex: 0 0 auto; justify-content: flex-start; transform: translateY(1px); }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const serverConfigs = useServerConfigs();
  // Older servers lack projects.listDirectory; they keep the capped
  // whole-tree listing until updated.
  const lazyMode =
    serverConfigs.get(environmentId)?.environment.capabilities.workspaceDirectoryListing === true;
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd, !lazyMode);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const symlinkTreePaths = useMemo(
    () => new Set(entries.filter((entry) => entry.symlink).map(treePath)),
    [entries],
  );
  const symlinkTreePathsRef = useRef<ReadonlySet<string>>(symlinkTreePaths);
  const ignoredGitStatus = useMemo(
    () =>
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({ path: treePath(entry), status: "ignored" as const })),
    [entries],
  );
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(treePath),
    [entries],
  );
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    // VS Code default: the tree opens fully collapsed, so the lazy loader
    // fetches nothing beyond the root listing until a folder is expanded.
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    // Rows are registered in treePath form (directories keep their trailing
    // slash), so the decoration lookup uses item.path as-is.
    renderRowDecoration: ({ item }) =>
      symlinkTreePathsRef.current.has(item.path)
        ? {
            icon: { name: "t3-file-icon-symlink", viewBox: "0 0 16 16", width: 11, height: 11 },
            title: "Symbolic link",
          }
        : null,
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const lazyTree = useLazyFileTree({
    model,
    environmentId,
    cwd,
    enabled: lazyMode,
    searchValue: search.value,
    entryKindsRef,
    symlinkTreePathsRef,
  });
  // The lazy tree only knows loaded directories, so the toggle works on the
  // root's direct children: expanding them fetches exactly one listing each
  // instead of cascading loads through the whole workspace.
  const toggleDirectoryPaths = lazyMode ? lazyTree.rootDirectoryPaths : directoryPaths;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, toggleDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    setAllDirectoriesExpanded(model, toggleDirectoryPaths, !allDirectoriesExpanded);
  };
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    if (lazyMode) {
      lazyTree.refresh();
    } else {
      entriesQuery.refresh();
    }
    onRefreshSelectedFile?.();
  };
  const filesPending = lazyMode ? lazyTree.isPending : entriesQuery.isPending;
  const filesError = lazyMode ? lazyTree.error : entriesQuery.error;
  const showFilesError = lazyMode
    ? lazyTree.error !== null
    : entriesQuery.error !== null && entriesQuery.data === null;
  // In lazy mode the filesystem watcher already converges the tree after
  // agent edits, so mutation-driven refreshes would only duplicate fetches.
  useWorkspaceMutationRefresh({
    enabled: !lazyMode,
    mutationId: workspaceMutationId,
    refresh: entriesQuery.refresh,
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  useEffect(() => {
    if (lazyMode) return;
    if (entriesQuery.data === null) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    symlinkTreePathsRef.current = symlinkTreePaths;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      model.setGitStatus(ignoredGitStatus);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (updates.length > 0) model.batch(updates);
    model.setGitStatus(ignoredGitStatus);
  }, [
    entriesQuery.data,
    entryKinds,
    ignoredGitStatus,
    lazyMode,
    model,
    symlinkTreePaths,
    treePaths,
  ]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }

    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      if (entryKindsRef.current.get(selectedPath) !== "file") return;
      const selectedItem = model.getItem(selectedPath);
      if (!selectedItem) return;

      // A selection that originated inside the tree (clicking a row, possibly
      // in an active tree search) is already visible; re-revealing it would
      // close the search and clobber the user's context. Only sync external
      // opens (file picker, content search, chat links).
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        handledRevealRef.current = revealRequest;
        return;
      }
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;

      syncingSelectionRef.current = true;
      model.closeSearch();
      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }

      // Directory rows are registered with a trailing slash (see treePath), so
      // ancestor lookups must use the same form to expand them.
      const segments = selectedPath.split("/");
      let ancestorPath = "";
      for (const segment of segments.slice(0, -1)) {
        ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
        const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
        if (item && "expand" in item) item.expand();
      }

      selectedItem.select();
      model.scrollToPath(selectedPath, { focus: true, offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    };

    if (lazyMode) {
      // The file may sit in a directory the lazy tree never expanded; load
      // its ancestors first, then run the same reveal as the legacy path.
      void lazyTree.ensurePathLoaded(selectedPath).then((loaded) => {
        if (loaded) {
          reveal();
        } else if (!cancelled) {
          // Give up on paths the workspace no longer contains; a new reveal
          // id retries after refresh.
          handledRevealRef.current = revealRequest;
        }
      });
    } else {
      reveal();
    }
    return () => {
      cancelled = true;
    };
  }, [entryKinds, lazyMode, lazyTree, model, selectedPath, selectedPathRevealId, treePaths]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={filesPending} onRefresh={handleRefresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
        {toggleDirectoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {showFilesError ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{filesError}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--contrast-foreground)",
          }}
        />
      )}
    </div>
  );
}
