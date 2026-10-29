import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  FONT_FAMILY,
  MainMenu,
  viewportCoordsToSceneCoords,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { useNavigate } from "@tanstack/react-router";
import { ClipboardCopyIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useTheme } from "../../hooks/useTheme";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { attachBoardImage, type BoardAttachTarget, readBoardAttachTarget } from "./boardAttach";
import { createBoardSaver, loadBoard, saveBoard } from "./boardStorage";
import { configureExcalidrawAssets } from "./excalidrawAssets";

configureExcalidrawAssets();

const SAVE_DELAY_MS = 400;
const EXPORT_MAX_EDGE = 4096;

const DEFAULT_APP_STATE = {
  currentItemStrokeColor: "#e03131",
  currentItemRoughness: 0,
  currentItemFontFamily: FONT_FAMILY.Nunito,
} satisfies Partial<AppState>;

async function loadInitialData(): Promise<ExcalidrawInitialDataState> {
  const saved = await loadBoard().catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Could not load the saved board",
      description: errorMessage(error),
    });
    return null;
  });
  if (!saved) return { appState: DEFAULT_APP_STATE };
  return {
    elements: saved.elements,
    files: saved.files,
    appState: {
      ...DEFAULT_APP_STATE,
      scrollX: saved.viewport.scrollX,
      scrollY: saved.viewport.scrollY,
      zoom: { value: saved.viewport.zoom as AppState["zoom"]["value"] },
    },
  };
}

function isWritableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function readImageSize(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight }),
    );
    image.addEventListener("error", () => reject(new Error("The pasted image could not be read.")));
    image.src = dataUrl;
  });
}

/** Pastes centre on the viewport; Excalidraw's own paste needs the pointer over the canvas. */
async function pasteImagesAtViewportCentre(api: ExcalidrawImperativeAPI, images: File[]) {
  const appState = api.getAppState();
  const centre = viewportCoordsToSceneCoords(
    {
      clientX: appState.offsetLeft + appState.width / 2,
      clientY: appState.offsetTop + appState.height / 2,
    },
    appState,
  );
  const zoom = appState.zoom.value;
  const added: ExcalidrawElement[] = [];
  for (const [index, image] of images.entries()) {
    const dataURL = (await readFileAsDataUrl(image)) as DataURL;
    const natural = await readImageSize(dataURL);
    const scale = Math.min(
      1 / window.devicePixelRatio,
      (0.8 * appState.width) / zoom / natural.width,
      (0.8 * appState.height) / zoom / natural.height,
    );
    const width = natural.width * scale;
    const height = natural.height * scale;
    const fileId = randomUUID() as FileId;
    api.addFiles([
      {
        id: fileId,
        dataURL,
        mimeType: image.type as BinaryFileData["mimeType"],
        created: Date.now(),
      },
    ]);
    const offset = (index * 24) / zoom;
    added.push(
      ...convertToExcalidrawElements([
        {
          type: "image",
          fileId,
          x: centre.x - width / 2 + offset,
          y: centre.y - height / 2 + offset,
          width,
          height,
        },
      ]),
    );
  }
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...added],
    appState: {
      selectedElementIds: Object.fromEntries(added.map((element) => [element.id, true])),
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** The selection when there is one, else the whole board. */
function exportBoardPng(api: ExcalidrawImperativeAPI) {
  const appState = api.getAppState();
  const all = api.getSceneElements();
  const selected = all.filter((element) => appState.selectedElementIds[element.id]);
  const elements = selected.length > 0 ? selected : all;
  if (elements.length === 0) return null;
  return exportToBlob({
    elements,
    files: api.getFiles(),
    appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
    mimeType: "image/png",
    exportPadding: 16,
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(2, EXPORT_MAX_EDGE / Math.max(width, height));
      return { width: width * scale, height: height * scale, scale };
    },
  });
}

function emptyBoardToast() {
  toastManager.add({
    type: "info",
    title: "The board is empty",
    description: "Paste a screenshot first.",
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again.";
}

export function BoardPage() {
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saver] = useState(() =>
    createBoardSaver(
      (snapshot) =>
        void saveBoard(snapshot).catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not save the board",
            description: errorMessage(error),
          }),
        ),
      SAVE_DELAY_MS,
    ),
  );

  const handleChange = (
    elements: ReadonlyArray<ExcalidrawElement>,
    appState: AppState,
    files: BinaryFiles,
  ) => {
    setHasSelection(
      elements.some((element) => !element.isDeleted && appState.selectedElementIds[element.id]),
    );
    saver.change(elements, appState, files);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes the pending IndexedDB save when the page hides or the board unmounts
  useEffect(() => {
    window.addEventListener("pagehide", saver.flush);
    return () => {
      window.removeEventListener("pagehide", saver.flush);
      saver.flush();
    };
  }, [saver]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- intercepts document paste so screenshots land on the board wherever the pointer is
  useEffect(() => {
    if (!api) return;
    const onPaste = (event: ClipboardEvent) => {
      if (isWritableTarget(event.target)) return;
      const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
        file.type.startsWith("image/"),
      );
      if (images.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void pasteImagesAtViewportCentre(api, images).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not paste the image",
          description: errorMessage(error),
        }),
      );
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, [api]);

  const copyPng = async () => {
    if (!api) return;
    const png = exportBoardPng(api);
    if (!png) return emptyBoardToast();
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toastManager.add({
        type: "success",
        title: hasSelection ? "Copied the selection" : "Copied the board",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: errorMessage(error),
      });
    }
  };

  const attachToChat = async () => {
    if (!api || busy) return;
    const exporting = exportBoardPng(api);
    if (!exporting) return emptyBoardToast();
    setBusy(true);
    try {
      const png = await exporting;
      let target: BoardAttachTarget | null = readBoardAttachTarget();
      if (target) {
        await (typeof target === "string"
          ? navigate({ to: "/draft/$draftId", params: { draftId: target } })
          : navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) }));
      } else if (defaultProjectRef) {
        target = (await handleNewThread(defaultProjectRef))?.draftId ?? null;
      }
      if (!target) throw new Error("Add a project, then try again.");
      await attachBoardImage(target, png);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not attach the board",
        description: errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!api) return;
    const confirmed = await readLocalApi()?.dialogs.confirm("Clear the board?", {
      variant: "destructive",
    });
    if (!confirmed) return;
    api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };

  const scope = hasSelection ? "selection" : "board";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Board</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="xs" variant="ghost" disabled={!api} onClick={() => void copyPng()}>
              <ClipboardCopyIcon />
              Copy {scope}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!api || busy}
              onClick={() => void attachToChat()}
            >
              <MessageSquarePlusIcon />
              Attach {scope} to chat
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label="Clear board"
              disabled={!api}
              onClick={() => void clear()}
            >
              <Trash2Icon />
            </Button>
          </div>
        </WorkspacePageHeader>
        <div className="relative min-h-0 flex-1">
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={loadInitialData}
            onChange={handleChange}
            theme={resolvedTheme}
            autoFocus
            UIOptions={{
              canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false },
            }}
          >
            <MainMenu>
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.Help />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Center>
                <WelcomeScreen.Center.Heading>
                  Paste a screenshot or drop an image here
                </WelcomeScreen.Center.Heading>
              </WelcomeScreen.Center>
              <WelcomeScreen.Hints.ToolbarHint />
            </WelcomeScreen>
          </Excalidraw>
        </div>
      </div>
    </SidebarInset>
  );
}
