/**
 * TS-side mirror of the CSS custom properties in `theme.css`, for the rare
 * case a value is needed in script rather than in a stylesheet (e.g. an
 * inline SVG stroke). Keep these in sync with theme.css by hand — there
 * aren't many of them.
 */
export const radii = {
  sm: "0.375rem",
  md: "0.5rem",
  lg: "0.75rem",
  xl: "1.5rem",
} as const;

export const semanticColor = {
  success: "#17c964",
  warning: "#f5a524",
  danger: "#ff383c",
} as const;

export type ThemeMode = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "physlib-gui:theme";
