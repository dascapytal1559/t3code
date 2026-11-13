// Fork: the main window's page, as the right panel's window growth needs it: sized ahead of
// the window where the platform allows, and watched for the frame it draws at a new size.
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

export interface PageViewSize {
  readonly width: number;
  readonly height: number;
}

export interface PageView {
  /** Sizes the page ahead of the window. False when it cannot, so the window resizes first. */
  readonly resizeAhead: (
    window: Electron.BrowserWindow,
    size: PageViewSize,
  ) => Effect.Effect<boolean>;
  /** Completes once the page has drawn a frame at the size it has now. */
  readonly drawn: (window: Electron.BrowserWindow) => Effect.Effect<void>;
}

/** Only for a page that cannot draw, such as a crashed renderer. */
const DRAW_WAIT_CAP = "1 second";

/** A capture waits for the first frame at the page's present size, and draws one if hidden. */
const drawn = (window: Electron.BrowserWindow) =>
  Effect.promise(() =>
    window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }).then(noop, noop),
  ).pipe(Effect.timeoutOption(DRAW_WAIT_CAP), Effect.asVoid);

const noop = () => {};

/** Chromium's NSView for a page; a window with DevTools docked holds two. */
const PAGE_VIEW_CLASS = "WebContentsViewCocoa";

/**
 * Electron's BrowserWindow keeps its page view to itself, so the view is reached through
 * the Objective-C runtime. AppKit clips a view wider than its window, and Chromium lays the
 * page out at the view's size, until the next window resize lays the view out again.
 */
const loadObjectiveC = () =>
  import("ffi-rs").then(({ DataType, load, open }) => {
    const library = "t3-objc";
    open({ library, path: "/usr/lib/libobjc.A.dylib" });
    const pointer = DataType.BigInt;
    const selector = (name: string) =>
      load({
        library,
        funcName: "sel_registerName",
        retType: pointer,
        paramsType: [DataType.String],
        paramsValue: [name],
      }) as bigint;
    const send = (target: bigint, name: string, index?: number) =>
      load({
        library,
        funcName: "objc_msgSend",
        retType: pointer,
        paramsType: index === undefined ? [pointer, pointer] : [pointer, pointer, pointer],
        paramsValue:
          index === undefined ? [target, selector(name)] : [target, selector(name), BigInt(index)],
      }) as bigint;
    return {
      className: (object: bigint) =>
        load({
          library,
          funcName: "class_getName",
          retType: DataType.String,
          paramsType: [pointer],
          paramsValue: [
            load({
              library,
              funcName: "object_getClass",
              retType: pointer,
              paramsType: [pointer],
              paramsValue: [object],
            }),
          ],
        }) as string,
      subviews: (view: bigint) => {
        const views = send(view, "subviews");
        return Array.from({ length: Number(send(views, "count")) }, (_, index) =>
          send(views, "objectAtIndex:", index),
        );
      },
      setFrameSize: (view: bigint, size: PageViewSize) => {
        load({
          library,
          funcName: "objc_msgSend",
          retType: DataType.Void,
          paramsType: [pointer, pointer, DataType.Double, DataType.Double],
          paramsValue: [view, selector("setFrameSize:"), size.width, size.height],
        });
      },
    };
  });

let objectiveC: ReturnType<typeof loadObjectiveC> | undefined;

/** The page fills the window only when it is the content view's one page view. */
const resizeMacPageView = (window: Electron.BrowserWindow, size: PageViewSize) =>
  Effect.promise(async () => {
    try {
      const runtime = await (objectiveC ??= loadObjectiveC());
      if (window.isDestroyed()) return false;
      const contentView = window.getNativeWindowHandle().readBigUInt64LE(0);
      const pageViews = runtime
        .subviews(contentView)
        .filter((view) => runtime.className(view) === PAGE_VIEW_CLASS);
      if (pageViews.length !== 1) return false;
      runtime.setFrameSize(pageViews[0]!, size);
      return true;
    } catch {
      // Without the runtime or the view, the window resizes first.
      return false;
    }
  });

export const macPageView: PageView = { resizeAhead: resizeMacPageView, drawn };

/** Elsewhere the window resizes first and the page follows, as any resized window's does. */
export const followingPageView: PageView = { resizeAhead: () => Effect.succeed(false), drawn };
