// @vitest-environment jsdom
import {
  act,
  cloneElement,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const theme = vi.hoisted(() => ({
  resolvedTheme: "dark" as "light" | "dark",
  listeners: new Set<() => void>(),
}));
vi.mock("../lib/mermaid", () => ({ renderMermaid: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    theme.listeners.add(listener);
    return () => {
      theme.listeners.delete(listener);
    };
  };
  return {
    useTheme: () => ({
      resolvedTheme: useSyncExternalStore(subscribe, () => theme.resolvedTheme),
    }),
  };
});
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger({
    render,
    children,
  }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
    if (!isValidElement(render)) return children;
    return children === undefined ? render : cloneElement(render, undefined, children);
  },
  TooltipPopup: () => null,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { renderMermaid } from "../lib/mermaid";

const render = vi.mocked(renderMermaid);
let renderer: Root;
let container: HTMLDivElement;

function deferredImage() {
  let resolve!: (image: string) => void;
  const promise = new Promise<string>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function update(code: string, isStreaming = false, language = "mermaid") {
  await act(async () => {
    renderer.render(
      createElement(ChatMarkdown, {
        cwd: "/tmp/project",
        text: `\`\`\`${language}\n${code}\n\`\`\``,
        isStreaming,
      }),
    );
  });
}

async function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull();
  await act(async () => button!.click());
}

describe("Mermaid Markdown fences", () => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    theme.resolvedTheme = "dark";
    render.mockReset();
    render.mockResolvedValue("data:image/svg+xml,diagram");
    await act(async () => {
      container = document.createElement("div");
      document.body.append(container);
      renderer = createRoot(container);
      renderer.render(createElement(ChatMarkdown, { cwd: undefined, text: "" }));
    });
  });

  afterEach(async () => {
    await act(async () => renderer.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("waits for streaming to finish, then supports source view and copying the original code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await update("flowchart LR\nA --> B", true);
    expect(render).not.toHaveBeenCalled();
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    await update("flowchart LR\nA --> B");
    expect(container.querySelector("img")?.src).toBe("data:image/svg+xml,diagram");
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    await click("Copy code");
    expect(writeText).toHaveBeenCalledWith("flowchart LR\nA --> B\n");
    await click("Show Mermaid source");
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    await click("Show Mermaid diagram");
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("leaves ordinary code fences alone and recognizes uppercase Mermaid fences", async () => {
    await update("const value = 1;", false, "javascript");
    expect(render).not.toHaveBeenCalled();
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    await update("flowchart LR\nA --> B", false, "Mermaid");
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("shows source after a render failure and recovers when the diagram is corrected", async () => {
    render.mockRejectedValueOnce(new Error("Invalid syntax"));
    await update("flowchart LR\nA[");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Unable to render");
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    await update("flowchart LR\nA --> Fixed");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("does not display stale async results after source or theme changes", async () => {
    const old = deferredImage();
    const current = deferredImage();
    render.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await update("flowchart LR\nOld --> Diagram");
    theme.resolvedTheme = "light";
    await update("flowchart LR\nNew --> Diagram");
    await act(async () => current.resolve("data:image/svg+xml,new-light"));
    await act(async () => old.resolve("data:image/svg+xml,old-dark"));
    expect(container.querySelector("img")?.src).toBe("data:image/svg+xml,new-light");
    expect(render).toHaveBeenLastCalledWith("flowchart TB\nNew --> Diagram\n", "light");
  });

  it("rerenders an unchanged diagram when only the theme changes", async () => {
    await update("flowchart LR\nSame --> Diagram");
    const light = deferredImage();
    render.mockReturnValueOnce(light.promise);
    theme.resolvedTheme = "light";
    await act(async () => {
      theme.listeners.forEach((listener) => listener());
    });
    expect(container.querySelector("img")).toBeNull();
    await act(async () => light.resolve("data:image/svg+xml,light"));
    expect(container.querySelector("img")?.src).toBe("data:image/svg+xml,light");
    expect(render).toHaveBeenLastCalledWith("flowchart TB\nSame --> Diagram\n", "light");
  });

  it("defaults to vertical flowcharts and lets the user restore the source direction", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await update("flowchart LR\nStart --> Finish");
    expect(render).toHaveBeenLastCalledWith("flowchart TB\nStart --> Finish\n", "dark");
    await click("Use original Mermaid direction");
    expect(render).toHaveBeenLastCalledWith("flowchart LR\nStart --> Finish\n", "dark");
    await click("Use original Mermaid direction");
    expect(render).toHaveBeenLastCalledWith("flowchart TB\nStart --> Finish\n", "dark");
    await click("Copy code");
    expect(writeText).toHaveBeenLastCalledWith("flowchart LR\nStart --> Finish\n");
    await click("Show Mermaid source");
    expect(container.querySelector("pre")?.textContent).toContain("flowchart LR");
  });
});
