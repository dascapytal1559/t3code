// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { renderMermaid } from "./mermaid";

function svgDocument(image: string) {
  expect(image.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  return new DOMParser().parseFromString(
    decodeURIComponent(image.slice(image.indexOf(",") + 1)),
    "image/svg+xml",
  );
}

describe("Mermaid rendering", () => {
  beforeAll(() => {
    // jsdom has no SVG layout. Stub measurements only; use Mermaid's real parser,
    // layout algorithms, SVG renderer and sanitizer for these tests.
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 160, height: 40 }),
    });
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value: () => 80,
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
    vi.restoreAllMocks();
  });

  it.each([
    ["flowchart", "flowchart LR\nStart --> Finish", "Start"],
    ["sequence", "sequenceDiagram\nAlice->>Bob: Hello", "Hello"],
    ["class", "classDiagram\nAnimal <|-- Duck", "Animal"],
    ["state", "stateDiagram-v2\n[*] --> Ready", "Ready"],
    ["entity relationship", "erDiagram\nCUSTOMER ||--o{ ORDER : places", "CUSTOMER"],
  ])("renders a %s diagram as a standalone SVG image", async (_name, code, label) => {
    const svg = svgDocument(await renderMermaid(code, "light"));
    expect(svg.querySelector("parsererror")).toBeNull();
    expect(svg.documentElement.tagName).toBe("svg");
    expect(svg.documentElement.textContent).toContain(label);
    expect(svg.querySelectorAll("path, line, rect").length).toBeGreaterThan(0);
    expect(Number(svg.documentElement.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(svg.documentElement.getAttribute("height"))).toBeGreaterThan(0);
    expect(svg.querySelector("foreignObject")).toBeNull();
    expect(document.body.childElementCount).toBe(0);
  });

  it("keeps concurrent themes separate and reuses completed diagrams", async () => {
    const code = "flowchart LR\nDay --> Night";
    const [light, dark, lightAgain] = await Promise.all([
      renderMermaid(code, "light"),
      renderMermaid(code, "dark"),
      renderMermaid(code, "light"),
    ]);
    expect(lightAgain).toBe(light);
    const lightStyle = svgDocument(light).querySelector("style")!.textContent;
    const darkStyle = svgDocument(dark).querySelector("style")!.textContent;
    expect(lightStyle).toContain("#ECECFF");
    expect(darkStyle).toContain("#1f2020");
  });

  it("cleans up parse failures and still renders the next diagram", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(renderMermaid("flowchart LR\nA[unfinished", "dark")).rejects.toThrow();
    expect(document.body.childElementCount).toBe(0);
    const svg = svgDocument(await renderMermaid("flowchart LR\nRecovered --> Done", "dark"));
    expect(svg.documentElement.textContent).toContain("Recovered");
  });

  it("rejects oversized input before rendering", async () => {
    await expect(renderMermaid("a".repeat(50_001), "dark")).rejects.toThrow("50,000");
    expect(document.body.childElementCount).toBe(0);
  });

  it("ignores attempts to enable HTML labels, links or a different theme", async () => {
    const code = `%%{init: {"securityLevel":"loose","htmlLabels":true,"theme":"dark"}}%%
flowchart LR
A["<img src=x onerror=alert(1)>"] --> B[Safe]
click B "javascript:alert(1)"`;
    const svg = svgDocument(await renderMermaid(code, "light"));
    expect(
      svg.querySelector("script, foreignObject, a[href], image, [onerror], [onclick]"),
    ).toBeNull();
    expect(svg.querySelector("style")!.textContent).toContain("#ECECFF");
  });
});
