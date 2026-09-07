import { describe, expect, it } from "vite-plus/test";

import { verticalMermaidSource } from "./mermaidLayout";

describe("vertical Mermaid flowcharts", () => {
  it.each(["flowchart LR", "graph RL", "flowchart BT", "flowchart-elk LR"])(
    "changes %s to a downward layout without changing its content",
    (header) => {
      const body = '\nA["flowchart LR"] --> B\nsubgraph Detail\ndirection LR\nC --> D\nend';
      expect(verticalMermaidSource(header + body)).toBe(header.replace(/\S+$/, "TB") + body);
    },
  );

  it.each([
    "\uFEFF  ",
    "%% comment\n",
    '%%{init: {"theme": "dark"}}%%\n',
    '%%{init: {\n"theme": "dark"\n}}%%\n',
    "---\ntitle: flowchart LR\n---\n%% comment\n",
    "---\r\ntitle: Example\r\n---\r\n",
  ])("preserves declaration prefixes: %j", (prefix) => {
    expect(verticalMermaidSource(prefix + "graph LR; A --> B")).toBe(prefix + "graph TB; A --> B");
  });

  it.each([
    "flowchart TD\nA --> B",
    "graph TB\nA --> B",
    "sequenceDiagram\nNote over A: flowchart LR",
    "stateDiagram-v2\ndirection LR\nA --> B",
    "classDiagram\ndirection LR\nAnimal <|-- Duck",
    "%% flowchart LR\nsequenceDiagram\nA->>B: Hi",
    "flowchart L",
    "flowchart LRNode --> B",
  ])("leaves other diagram declarations unchanged: %j", (code) => {
    expect(verticalMermaidSource(code)).toBe(code);
  });
});
