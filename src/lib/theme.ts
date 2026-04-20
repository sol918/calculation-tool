/**
 * Building-system theme tint. Each kengetalSet has a themeColor (hex).
 * We expose it via a CSS variable `--system-tint` so pages/components can
 * reference it for accents, borders, and subtle backgrounds.
 *
 * Tint is applied inline via `style={systemTintStyle(color)}` on a wrapper.
 * Helpers below convert a hex colour into the transparent accent tones we use.
 */

export interface SystemTintStyle extends React.CSSProperties {
  "--system-tint"?: string;
  "--system-tint-soft"?: string;
  "--system-tint-softer"?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/.{1,2}/g);
  if (!m || m.length < 3) return [15, 23, 42];
  return [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)];
}

export function systemTintStyle(color: string | null | undefined): SystemTintStyle {
  const hex = color || "#0ea5e9";
  const [r, g, b] = hexToRgb(hex);
  return {
    "--system-tint": hex,
    "--system-tint-soft": `rgba(${r}, ${g}, ${b}, 0.10)`,
    "--system-tint-softer": `rgba(${r}, ${g}, ${b}, 0.04)`,
  } as SystemTintStyle;
}
