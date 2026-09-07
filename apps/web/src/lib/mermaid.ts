import { LRUCache } from "./lruCache";

const MAX_SOURCE_LENGTH = 50_000;
const diagrams = new LRUCache<string>(100, 10 * 1024 * 1024);
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;

/** Mermaid has global configuration, so theme changes and rendering must share a queue. */
export function renderMermaid(code: string, theme: "light" | "dark"): Promise<string> {
  if (code.length > MAX_SOURCE_LENGTH) {
    return Promise.reject(new Error("Mermaid diagram exceeds the 50,000 character limit."));
  }
  const key = `${theme}:${code}`;
  const render = renderQueue.then(async () => {
    const cached = diagrams.get(key);
    if (cached !== null) return cached;

    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: MAX_SOURCE_LENGTH,
      maxEdges: 500,
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "Arial, sans-serif",
      htmlLabels: false,
      // Diagram directives must not override the host's safety or display settings.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "maxEdges",
        "theme",
        "fontFamily",
        "htmlLabels",
      ],
    });

    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`t3-mermaid-${++nextDiagramId}`, code, container);
      // An SVG image isolates diagram styles and IDs from the app and other diagrams.
      // Explicit dimensions preserve readable text and allow wide diagrams to scroll.
      const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = svgDocument.documentElement;
      const viewBox = root
        .getAttribute("viewBox")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
        root.setAttribute("width", String(viewBox[2]));
        root.setAttribute("height", String(viewBox[3]));
      }
      const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
      diagrams.set(key, image, (key.length + image.length) * 2);
      return image;
    } finally {
      container.remove();
    }
  });
  // A malformed diagram must not prevent subsequent diagrams from rendering.
  renderQueue = render.catch(() => {});
  return render;
}
