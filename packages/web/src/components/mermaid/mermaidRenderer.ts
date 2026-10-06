import { buildMermaidSrcDoc, parseSvgAspect } from "./mermaidFrame";
import { MERMAID_PALETTES } from "./mermaidTheme";
import type { MermaidRenderTheme } from "./mermaidTheme";
export type { MermaidRenderTheme } from "./mermaidTheme";

export interface MermaidRenderResult {
  svg: string;
  srcDoc: string;
  width: number;
  height: number;
  theme: MermaidRenderTheme;
}

type MermaidModule = typeof import("mermaid");
type MermaidApi = MermaidModule["default"];

const MAX_RENDER_CACHE_ENTRIES = 48;
const renderCache = new Map<string, Promise<MermaidRenderResult>>();
let mermaidModulePromise: Promise<MermaidApi> | null = null;
let nextDiagramId = 0;

// Mermaid owns mutable global configuration. Keep initialize + parse + render
// in one app queue so concurrent diagrams cannot borrow another mode's palette.
let renderQueue: Promise<void> = Promise.resolve();

function initializeMermaid(mermaid: MermaidApi, theme: MermaidRenderTheme) {
  const palette = MERMAID_PALETTES[theme];
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    securityLevel: "strict",
    theme: "base",
    // Pure SVG labels remain portable through the SVG → PNG export path.
    htmlLabels: false,
    themeVariables: {
      darkMode: theme === "dark",
      background: palette.background,
      primaryColor: palette.surface,
      primaryTextColor: palette.foreground,
      primaryBorderColor: palette.border,
      lineColor: palette.foreground,
      secondaryColor: palette.surface,
      secondaryTextColor: palette.foreground,
      tertiaryColor: palette.background,
      tertiaryTextColor: palette.foreground,
      textColor: palette.foreground,
      edgeLabelBackground: palette.background,
      noteBkgColor: palette.surface,
      noteTextColor: palette.foreground,
      noteBorderColor: palette.border,
    },
  });
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid")
      .then(({ default: mermaid }) => {
        initializeMermaid(mermaid, "light");
        return mermaid;
      })
      .catch((error) => {
        mermaidModulePromise = null;
        throw error;
      });
  }
  return mermaidModulePromise;
}

function renderCacheKey(code: string, theme: MermaidRenderTheme): string {
  return `${theme}\u0000${code}`;
}

function touchCacheEntry(key: string, value: Promise<MermaidRenderResult>) {
  renderCache.delete(key);
  renderCache.set(key, value);
  while (renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey === undefined) break;
    renderCache.delete(oldestKey);
  }
}

/**
 * Parse + asynchronously render one diagram after the official Mermaid lazy
 * chunk is requested.
 * The promise cache coalesces duplicate diagrams and includes the resolved
 * light/dark mode in its key, so a theme switch never reuses stale SVG ink.
 */
export function renderMermaidDiagram(
  code: string,
  theme: MermaidRenderTheme,
): Promise<MermaidRenderResult> {
  const key = renderCacheKey(code, theme);
  const cached = renderCache.get(key);
  if (cached) {
    touchCacheEntry(key, cached);
    return cached;
  }

  const rendered = loadMermaid().then((mermaid) => {
    // Validate independently so syntax failures never reach Mermaid's DOM
    // renderer. suppressErrorRendering prevents the renderer from inserting
    // its own error diagram; our component owns the visible error state.
    // `parse` is serialized by Mermaid's global queue. Run its synchronous
    // detector first so an obviously unknown diagram type cannot wait behind
    // unrelated valid diagrams that are already rendering. This keeps the
    // consumer's generic error state timely without duplicating Mermaid's
    // grammar or weakening the async render path for recognized types.
    mermaid.detectType(code);
    const job = renderQueue.then(async () => {
      initializeMermaid(mermaid, theme);
      await mermaid.parse(code);
      const diagramId = `raft-mermaid-${++nextDiagramId}`;
      const { svg: renderedSvg } = await mermaid.render(diagramId, code);
      // Make the standalone SVG as readable as the iframe and PNG export.
      const svgDocument = new DOMParser().parseFromString(renderedSvg, "image/svg+xml");
      const svgRoot = svgDocument.querySelector("svg");
      if (!svgRoot) throw new Error("Mermaid did not return an SVG");
      svgRoot.style.backgroundColor = MERMAID_PALETTES[theme].background;
      const svg = svgRoot.outerHTML;
      const { w, h } = parseSvgAspect(svg);
      return {
        svg,
        srcDoc: buildMermaidSrcDoc(svg),
        width: w,
        height: h,
        theme,
      };
    });
    // A failed diagram must not block later jobs in either theme.
    renderQueue = job.then(() => undefined, () => undefined);
    return job;
  });

  const guarded = rendered.catch((error) => {
    // A syntax error must not poison future attempts after the source changes,
    // and a transient chunk failure must remain retryable.
    if (renderCache.get(key) === guarded) renderCache.delete(key);
    throw error;
  });
  touchCacheEntry(key, guarded);
  return guarded;
}
