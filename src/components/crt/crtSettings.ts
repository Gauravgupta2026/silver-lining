/**
 * Everything that describes one CRT-screen picture. The studio edits a CrtSettings object and the
 * site renders the same object, so what you tune is what ships.
 *
 * The defaults come from measuring a reference "ASCII Magic" CRT render (blue and green variants):
 * ~283 monospace cells across, vertical aperture-grille stripes one cell wide, a barrel curve of
 * about 2%, a 2.2% black bezel, luma grain of std ~4%, and a heavy, wide bloom.
 */

export type RGB = readonly [number, number, number];

/** Six stops of the colour ramp, dark to light, 0-255. */
export type Ramp = readonly [RGB, RGB, RGB, RGB, RGB, RGB];

export const CRT_LOOKS = {
  cobalt: {
    name: "Cobalt",
    hint: "Indigo shadows and cyan-white highlights, like a blue-tinted tube.",
    ramp: [[6, 4, 14], [42, 43, 74], [80, 104, 124], [118, 158, 164], [168, 210, 208], [246, 248, 247]],
  },
  phosphor: {
    name: "Phosphor",
    hint: "Green monochrome terminal glass.",
    ramp: [[2, 5, 3], [8, 22, 14], [30, 78, 50], [92, 172, 128], [186, 236, 206], [242, 255, 247]],
  },
  amber: {
    name: "Amber",
    hint: "Warm amber monitor.",
    ramp: [[8, 4, 1], [40, 18, 4], [124, 62, 10], [226, 140, 34], [255, 208, 120], [255, 247, 224]],
  },
  mono: {
    name: "Mono",
    hint: "Cool black-and-white television.",
    ramp: [[4, 5, 6], [24, 26, 29], [66, 70, 76], [132, 138, 146], [204, 209, 215], [250, 252, 253]],
  },
} as const satisfies Record<string, { name: string; hint: string; ramp: Ramp }>;

export type CrtLookKey = keyof typeof CRT_LOOKS;

export const GLYPH_SETS = {
  blocks: { name: "Blocks", hint: "Solid cells, like a low-resolution mosaic." },
  ascii: { name: "ASCII", hint: "Text characters, from thin to dense." },
  dots: { name: "Dots", hint: "Round dots on a staggered grid, like halftone." },
} as const;
export type GlyphSetKey = keyof typeof GLYPH_SETS;

export const MASKS = {
  grille: { name: "Stripes", hint: "Vertical phosphor stripes, like a Trinitron." },
  dots: { name: "Dots", hint: "A shadow mask of staggered dots." },
  none: { name: "Off", hint: "A clean screen with no mask." },
} as const;
export type MaskKey = keyof typeof MASKS;

export type InvertMode = "auto" | "on" | "off";
export const INVERT_MODES: Record<InvertMode, { name: string; hint: string }> = {
  auto: { name: "Auto", hint: "Pictures on a light background glow on a dark screen." },
  on: { name: "Flip", hint: "Swap light and dark." },
  off: { name: "Keep", hint: "Use the picture's own light and dark." },
};

export interface CrtSettings {
  look: CrtLookKey;
  glyphs: GlyphSetKey;
  mask: MaskKey;
  invert: InvertMode;
  /** Cells across the picture. */
  columns: number;
  /** 0 flat cells, 1 full glyph shapes. */
  glyphMix: number;
  exposure: number;
  contrast: number;
  /** Strength of the glow round bright areas. */
  bloom: number;
  /** Beam focus: 0 sharp cells, higher softens them into each other. */
  focus: number;
  /** Mask stripes or dots across the picture. */
  maskDensity: number;
  maskStrength: number;
  scanlines: number;
  /** Barrel curve of the glass. */
  curve: number;
  /** Bezel width, share of the screen width. */
  bezel: number;
  /** Red/blue split at edges and bright specks. */
  aberration: number;
  grain: number;
  /** Rare bright cells in dark areas. */
  sparkle: number;
  flicker: number;
  /** Slow bright band rolling down the screen. */
  roll: number;
  /** Rare horizontal tears. */
  glitch: number;
  /** How strongly the cursor bends the picture. */
  lens: number;
}

export type CrtSettingsInput = Partial<CrtSettings>;

export const NUMERIC_RANGES = {
  columns: { min: 40, max: 400, step: 1 },
  glyphMix: { min: 0, max: 1, step: 0.01 },
  exposure: { min: 0.4, max: 2.5, step: 0.01 },
  contrast: { min: 0.5, max: 3, step: 0.01 },
  bloom: { min: 0, max: 2, step: 0.01 },
  focus: { min: 0, max: 2.5, step: 0.01 },
  maskDensity: { min: 60, max: 600, step: 1 },
  maskStrength: { min: 0, max: 1, step: 0.01 },
  scanlines: { min: 0, max: 1, step: 0.01 },
  curve: { min: 0, max: 0.1, step: 0.001 },
  bezel: { min: 0, max: 0.08, step: 0.001 },
  aberration: { min: 0, max: 1.5, step: 0.01 },
  grain: { min: 0, max: 1.5, step: 0.01 },
  sparkle: { min: 0, max: 1, step: 0.01 },
  flicker: { min: 0, max: 1, step: 0.01 },
  roll: { min: 0, max: 1, step: 0.01 },
  glitch: { min: 0, max: 1, step: 0.01 },
  lens: { min: 0, max: 1, step: 0.01 },
} as const satisfies Record<string, { min: number; max: number; step: number }>;

type NumericKey = keyof typeof NUMERIC_RANGES;

/** The blue reference: stripes, solid cells, heavy bloom, rare specks. */
const COBALT: CrtSettings = {
  look: "cobalt",
  glyphs: "blocks",
  mask: "grille",
  invert: "auto",
  columns: 220,
  glyphMix: 0.35,
  exposure: 1,
  contrast: 1.15,
  bloom: 1.2,
  focus: 0.9,
  maskDensity: 220,
  maskStrength: 0.8,
  scanlines: 0,
  curve: 0.022,
  bezel: 0.022,
  aberration: 0.5,
  grain: 0.5,
  sparkle: 0.35,
  flicker: 0.2,
  roll: 0.15,
  glitch: 0.1,
  lens: 0.5,
};

export const CRT_PRESETS: Record<CrtLookKey, { name: string; hint: string; settings: CrtSettings }> = {
  cobalt: { name: CRT_LOOKS.cobalt.name, hint: CRT_LOOKS.cobalt.hint, settings: COBALT },
  // The green reference: dim picture, bright details only, dot mask over a dot grid.
  phosphor: {
    name: CRT_LOOKS.phosphor.name,
    hint: CRT_LOOKS.phosphor.hint,
    settings: { ...COBALT, look: "phosphor", glyphs: "dots", mask: "dots", columns: 130, glyphMix: 0.7, exposure: 0.95, contrast: 1.9, bloom: 0.8, maskDensity: 190, maskStrength: 0.75, aberration: 0.15, grain: 0.45, sparkle: 0.15, flicker: 0.12, roll: 0.08 },
  },
  amber: {
    name: CRT_LOOKS.amber.name,
    hint: CRT_LOOKS.amber.hint,
    settings: { ...COBALT, look: "amber", glyphs: "ascii", mask: "grille", columns: 120, glyphMix: 0.85, exposure: 1.1, contrast: 1.6, bloom: 0.9, maskDensity: 150, maskStrength: 0.55, scanlines: 0.35, aberration: 0.3, sparkle: 0.2 },
  },
  mono: {
    name: CRT_LOOKS.mono.name,
    hint: CRT_LOOKS.mono.hint,
    settings: { ...COBALT, look: "mono", glyphs: "ascii", mask: "none", columns: 150, glyphMix: 0.9, exposure: 1.05, contrast: 1.7, bloom: 0.75, scanlines: 0.3, aberration: 0.2, sparkle: 0.25, flicker: 0.3 },
  },
};

export const DEFAULT_CRT_SETTINGS: CrtSettings = CRT_PRESETS.cobalt.settings;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Fills gaps with defaults and clamps every number into its slider range. Safe on untrusted JSON. */
export function resolveCrtSettings(input?: CrtSettingsInput | null): CrtSettings {
  const merged: CrtSettings = { ...DEFAULT_CRT_SETTINGS, ...(input ?? {}) };
  if (!(merged.look in CRT_LOOKS)) merged.look = DEFAULT_CRT_SETTINGS.look;
  if (!(merged.glyphs in GLYPH_SETS)) merged.glyphs = DEFAULT_CRT_SETTINGS.glyphs;
  if (!(merged.mask in MASKS)) merged.mask = DEFAULT_CRT_SETTINGS.mask;
  if (!(merged.invert in INVERT_MODES)) merged.invert = DEFAULT_CRT_SETTINGS.invert;
  for (const key of Object.keys(NUMERIC_RANGES) as NumericKey[]) {
    const { min, max } = NUMERIC_RANGES[key];
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) ? clamp(value, min, max) : DEFAULT_CRT_SETTINGS[key];
  }
  return merged;
}
