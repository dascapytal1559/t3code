import { useEffect, useState, type ReactNode } from "react";

import { renderMermaid } from "../lib/mermaid";

export function MermaidDiagram({
  code,
  theme,
  isStreaming,
  fallback,
}: {
  code: string;
  theme: "light" | "dark";
  isStreaming: boolean;
  fallback: ReactNode;
}) {
  const [result, setResult] = useState<{
    code: string;
    theme: "light" | "dark";
    image: string | null;
  } | null>(null);

  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    void renderMermaid(code, theme).then(
      (image) => {
        if (!cancelled) setResult({ code, theme, image });
      },
      () => {
        if (!cancelled) setResult({ code, theme, image: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, theme, isStreaming]);

  const current = !isStreaming && result?.code === code && result.theme === theme ? result : null;
  if (current?.image) {
    return (
      <div className="overflow-x-auto p-3">
        <img
          src={current.image}
          alt="Mermaid diagram"
          className="mx-auto block max-w-none"
          onError={() => setResult({ code, theme, image: null })}
        />
      </div>
    );
  }

  return (
    <>
      <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">
        {isStreaming
          ? "Diagram will render when the response finishes."
          : current
            ? "Unable to render Mermaid diagram. Source is shown below."
            : "Rendering diagram…"}
      </p>
      {fallback}
    </>
  );
}
