export type MermaidRenderTheme = "light" | "dark";

// The opaque SVG document and PNG canvas cannot inherit app CSS variables.
// Keep their literal palettes together and match the code/diagram surfaces.
export const MERMAID_PALETTES = {
  light: { background: "#ffffff", surface: "#f5f0e8", foreground: "#141111", border: "#57534e" },
  dark: { background: "#0a0c10", surface: "#202a38", foreground: "#f0f3f6", border: "#9ea7b3" },
} as const;
