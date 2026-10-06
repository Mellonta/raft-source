import { memo, useContext, useMemo, useState } from "react";
import type { Context } from "react";
import { IntlContext } from "react-intl";

import pixelAvatars from "../../../assets/avatars/pixelAvatars.json";
import { en } from "../../i18n/messages/en";

/**
 * Pixel art avatar system for agents.
 * Each avatar is an 8×8 sprite rendered as ONE <img> whose src is a cached
 * SVG data URL (task #137). It used to be a CSS grid of 64 <div>s per avatar:
 * a busy channel carried 134 avatars = 8,710 of its 14,827 DOM nodes (59%),
 * inflating every style/layout pass over the timeline and sidebar.
 * Stored as avatarUrl = "pixel:key" (predefined) or "pixel:random:seed" (generated).
 *
 * Canonical palette + sprite data live in assets/avatars/pixelAvatars.json
 * (grid rows as compact 8-char palette-letter strings); this module expands
 * them into render-time shapes. The seeded-random generator below stays in
 * code — only the hand-drawn sprites are data. Drift guard:
 * tests/pixelAvatarJson.test.ts.
 */

// Color palette — soft pastel. Letter → hex values live in pixelAvatars.json.
// Aligned with design-system tokens in `slock-design/tokens/colors.json`
// v1.2.0 (2026-05-03): O/C/L/R match the OKLCH-aligned named palette
// (soft-orange / soft-cyan / soft-lime / soft-coral). G + B stay
// avatar-specific because the role palette has no green / blue-gray; D is the
// mug-only latte brown (NOT a design token, do not promote / do not sync to
// token JSON). Keep in sync with `slock-landing/src/components/PixelAvatar.tsx`.
const C = pixelAvatars.palette;

type PaletteKey = keyof typeof C;
type OptionalAvatarIntl = {
  formatMessage: (descriptor: { id: "agent.avatar.alt" }) => string;
};

// 8×8 pixel art definitions, expanded from the JSON's compact row strings
// ("_KKKKKK_" → PaletteKey[]). A bg letter resolves through the palette; a
// literal `#hex` bg (the reserved finch/mug one-offs — soft-sky #D7F3FB and
// soft-cream #F8EEDF, intentionally NOT promoted into `C`) passes through
// as-is. Entry order follows the JSON and drives the picker grid order.
const AVATARS: Record<string, { grid: PaletteKey[][]; bg: string }> = Object.fromEntries(
  Object.entries(pixelAvatars.avatars).map(([key, { bg, grid }]) => [
    key,
    {
      bg: bg.startsWith("#") ? bg : C[bg as PaletteKey],
      grid: grid.map((row) => row.split("") as PaletteKey[]),
    },
  ]),
);

// Avatar keys reserved for specific agents — must not be picked at random
// (CreateAgentDialog) or surfaced in the manual picker grid
// (AgentDetailPanel). `finch` and `mug` belong to the Cindy OA agent only
// (Duoyu 2026-06-02 DM, cindyz approved; mug FINAL locked by cindyz
// 2026-07-01, supersedes the earlier orange mugWink shipped in #3616).
export const RESERVED_AVATAR_KEYS: readonly string[] = pixelAvatars.reservedKeys;

export const AVATAR_KEYS = Object.keys(AVATARS).filter(
  (k) => !RESERVED_AVATAR_KEYS.includes(k),
);

/** Default avatar key used when agent has no avatar set */
export const DEFAULT_AVATAR_KEY = pixelAvatars.defaultKey;

export function getAvatarData(key: string) {
  return AVATARS[key] || null;
}

// --- Seeded random pixel avatar generator ---

/** Simple seeded PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit integer */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Pre-defined harmonious color schemes: [background, foreground].
 * Each scheme pairs a light bg with a contrasting fg for clean identicon look.
 */
const COLOR_SCHEMES: [string, PaletteKey][] = [
  [C.C, "K"],   // cyan bg, black fg
  [C.Y, "K"],   // yellow bg, black fg
  [C.L, "K"],   // lime bg, black fg
  [C.P, "W"],   // pink bg, white fg
  [C.V, "K"],   // lavender bg, black fg
  ["#1E1E1C", "C"],  // dark bg, cyan fg
  ["#1E1E1C", "G"],  // dark bg, green fg
  ["#1E1E1C", "P"],  // dark bg, pink fg
  ["#1E1E1C", "Y"],  // dark bg, yellow fg
  ["#1E1E1C", "V"],  // dark bg, lavender fg
  [C.O, "K"],   // orange bg, black fg
  [C.C, "W"],   // cyan bg, white fg
];

/** Cache for generated avatars to avoid recalculating */
const generatedCache = new Map<string, { grid: PaletteKey[][]; bg: string }>();

/**
 * Generate a deterministic 8×8 identicon-style pixel avatar from a seed string.
 * Uses a 5×8 grid (center column + left half mirrored to right) for vertical symmetry,
 * with a single foreground color on a harmonious background — similar to GitHub identicons.
 */
function generateAvatar(seed: string): { grid: PaletteKey[][]; bg: string } {
  const cached = generatedCache.get(seed);
  if (cached) return cached;

  const rng = mulberry32(hashString(seed));
  const scheme = COLOR_SCHEMES[Math.floor(rng() * COLOR_SCHEMES.length)];
  const bg = scheme[0];
  const fg = scheme[1];

  // Generate a 4×8 half-grid (left side), then mirror horizontally.
  // ~45% fill rate gives recognizable shapes without being too dense or sparse.
  const grid: PaletteKey[][] = [];
  for (let y = 0; y < 8; y++) {
    const left: PaletteKey[] = [];
    for (let x = 0; x < 4; x++) {
      left.push(rng() < 0.45 ? fg : "_");
    }
    // Mirror: columns 0-3 then 3-0 (8 wide, center columns 3,4 share same value)
    grid.push([left[0], left[1], left[2], left[3], left[3], left[2], left[1], left[0]]);
  }

  const result = { grid, bg };
  generatedCache.set(seed, result);
  return result;
}

/** Sprite data for a key: a predefined sprite, or "random:<seed>" generated. */
export function getPixelAvatarData(avatarKey: string): { grid: PaletteKey[][]; bg: string } | null {
  if (avatarKey.startsWith("random:")) return generateAvatar(avatarKey.slice(7));
  return AVATARS[avatarKey] || null;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const dataUrlCache = new Map<string, string | null>();

/**
 * The avatar as one SVG data URL (8×8 viewBox, crisp edges). Single source for
 * the live avatar and for share/screenshot capture. Cached per key: sprites are
 * immutable and palette colors are fixed (not theme tokens).
 */
export function pixelAvatarDataUrl(avatarKey: string): string | null {
  const cached = dataUrlCache.get(avatarKey);
  if (cached !== undefined) return cached;
  const data = getPixelAvatarData(avatarKey);
  let url: string | null = null;
  if (data) {
    const cells = data.grid.flatMap((row, y) => row.flatMap((colorKey, x) =>
      colorKey === "_" ? [] : [`<rect x="${x}" y="${y}" width="1" height="1" fill="${C[colorKey]}"/>`]));
    url = svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${data.bg}"/>${cells.join("")}</svg>`);
  }
  dataUrlCache.set(avatarKey, url);
  return url;
}

/** Parse "pixel:key" or "pixel:random:seed" format from avatarUrl */
export function parsePixelAvatar(avatarUrl: string | null): string | null {
  if (!avatarUrl?.startsWith("pixel:")) return null;
  return avatarUrl.slice(6);
}

/** Get the effective pixel avatar key for an agent (falls back to default) */
function getEffectiveAvatarKey(avatarUrl: string | null): string {
  return parsePixelAvatar(avatarUrl) || DEFAULT_AVATAR_KEY;
}

/** Render a pixel art avatar at the given size */
const PixelAvatar = memo(function PixelAvatar({
  avatarKey,
  size = 40,
  className = "",
}: {
  avatarKey: string;
  size?: number;
  className?: string;
}) {
  const src = useMemo(() => pixelAvatarDataUrl(avatarKey), [avatarKey]);
  if (!src) return null;

  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={`shrink-0 ${className}`}
      style={{
        // Default to fixed `size`. Callers can override via className
        // (`!w-full !h-full`) to make the sprite fill its parent — used by
        // AvatarSlot to push pixels flush to the border on non-integer
        // DPR devices.
        width: size,
        height: size,
        imageRendering: "pixelated",
      }}
      data-agent-pixel-avatar="true"
      data-cell-size={size / 8}
    />
  );
});

/** Check if avatarUrl is a custom image (not pixel:* format) */
export function isCustomAvatar(avatarUrl: string | null): boolean {
  if (!avatarUrl) return false;
  return !avatarUrl.startsWith("pixel:");
}

/** Render an agent avatar — custom image if uploaded, pixel art otherwise */
export const AgentAvatar = memo(function AgentAvatar({
  avatarUrl,
  size = 40,
  className = "",
}: {
  avatarUrl: string | null;
  size?: number;
  className?: string;
}) {
  // Some legacy test render trees mount this shared leaf without IntlProvider.
  const intl = useContext(IntlContext as unknown as Context<OptionalAvatarIntl | null>);
  const avatarAlt = intl?.formatMessage({ id: "agent.avatar.alt" }) ?? en["agent.avatar.alt"];
  const [failedCustomUrl, setFailedCustomUrl] = useState<string | null>(null);
  if (isCustomAvatar(avatarUrl) && avatarUrl !== failedCustomUrl) {
    return (
      <img
        src={avatarUrl!}
        alt={avatarAlt}
        className={`shrink-0 object-cover ${className}`}
        style={{ width: size, height: size }}
        onError={() => setFailedCustomUrl(avatarUrl)}
      />
    );
  }
  return <PixelAvatar avatarKey={getEffectiveAvatarKey(avatarUrl)} size={size} className={className} />;
});

export default PixelAvatar;
