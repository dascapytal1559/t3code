// Excalidraw loads canvas fonts from `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>`, else a CDN the
// desktop CSP blocks. Ship the Latin fonts; CJK (Xiaolai, 12 MB) stays on the CDN fallback.
const fontUrls = import.meta.glob<string>(
  "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/{Assistant,Cascadia,ComicShanns,Excalifont,Liberation,Lilita,Nunito,Virgil}/*.woff2",
  { query: "?url&no-inline", import: "default", eager: true },
);

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export function configureExcalidrawAssets() {
  const sample = Object.values(fontUrls)[0];
  if (!sample) return;
  const url = new URL(sample, window.location.href);
  url.search = "";
  url.pathname = url.pathname.replace(/fonts\/[^/]+\/[^/]+$/, "");
  window.EXCALIDRAW_ASSET_PATH = url.href;
}
