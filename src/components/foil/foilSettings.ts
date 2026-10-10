/**
 * Everything that describes one foil illustration. The studio edits a FoilSettings object and the
 * site renders the same object, so what you tune is what ships.
 *
 * Option lists and default amounts are taken from bubbbly.com/foil-studio.
 */

export type RGB = readonly [number, number, number];

export type FoilMode =
  /** Every opaque, non-background pixel turns to foil. Best for line art. */
  | "all"
  /** Fine lines and dark detail turn to foil (local darkness vs. surroundings). */
  | "details"
  /** The darkest parts turn to foil. */
  | "darks"
  /** One picked colour turns to foil. */
  | "colour";

export interface FoilModeInfo {
  name: string;
  hint: string;
  /** Slider range for `amount`. */
  range: readonly [number, number];
  defaultAmount: number;
}

export const FOIL_MODES: Record<FoilMode, FoilModeInfo> = {
  all: { name: "All of it", hint: "Everything that isn't background turns to foil.", range: [0, 1], defaultAmount: 1 },
  details: { name: "Details", hint: "The fine lines and dark detail turn to foil.", range: [0.02, 0.4], defaultAmount: 0.115 },
  darks: { name: "Shadows", hint: "The darkest parts turn to foil.", range: [0.02, 0.6], defaultAmount: 0.15 },
  colour: { name: "A colour", hint: "Click the picture to choose the colour that turns to foil.", range: [0, 1], defaultAmount: 0.35 },
};

export interface FoilFinish {
  name: string;
  /** Flat colour the foil is printed in, 0-255. */
  ink: RGB;
  /** Colour of the specular flash, 0-1. */
  tint: RGB;
  /** Rainbow ink pattern plus pearl sheen. */
  holo?: boolean;
}

export const FOILS = {
  gold: { name: "Gold", ink: [214, 170, 92], tint: [1, 0.72, 0.3] },
  silver: { name: "Silver", ink: [200, 203, 210], tint: [0.88, 0.9, 0.97] },
  rose: { name: "Rose gold", ink: [226, 162, 142], tint: [1, 0.7, 0.58] },
  copper: { name: "Copper", ink: [200, 122, 80], tint: [1, 0.58, 0.36] },
  pink: { name: "Pink", ink: [228, 128, 168], tint: [1, 0.58, 0.8] },
  holo: { name: "Holographic", ink: [206, 210, 220], tint: [0.9, 0.92, 1], holo: true },
} as const satisfies Record<string, FoilFinish>;

export type FoilKey = keyof typeof FOILS;

/**
 * What happens to a plain background (detected from the image border).
 * "transparent" cuts it out so the art sits on the page; "keep" leaves it untouched;
 * a paper key repaints it in that stock, keeping the picture's own shading.
 */
export const PAPERS = {
  white: { name: "White", rgb: [245, 244, 241] },
  cream: { name: "Cream", rgb: [241, 233, 217] },
  blush: { name: "Blush", rgb: [236, 202, 198] },
  sage: { name: "Sage", rgb: [200, 212, 192] },
  sky: { name: "Sky", rgb: [200, 214, 230] },
  midnight: { name: "Midnight", rgb: [42, 46, 64] },
} as const satisfies Record<string, { name: string; rgb: RGB }>;

export type PaperKey = keyof typeof PAPERS;
export type Ground = "transparent" | "keep" | PaperKey;

export const SHAPES = {
  original: { name: "Original", aspect: 0 },
  portrait: { name: "Portrait", aspect: 5 / 7 },
  square: { name: "Square", aspect: 1 },
  landscape: { name: "Landscape", aspect: 1.4 },
} as const;

export type ShapeKey = keyof typeof SHAPES;

/** Look settings applied live by the shader; changing them never rebuilds the maps. */
export interface FoilLook {
  /** Emboss strength. The original uses 2.6. */
  relief: number;
  /** Fine surface noise on the foil. */
  crinkle: number;
  /** Strength of the white-hot lamp flash. */
  shine: number;
  /** Lamp height as a share of the camera distance. Lower = tighter spot. */
  lampHeight: number;
  /** Paper fibre texture on the non-foil parts. */
  grain: number;
}

export interface FoilSettings {
  mode: FoilMode;
  /** Mode-specific: share of pixels (details/darks) or colour tolerance (colour). */
  amount: number;
  /** Picked colour for "colour" mode, 0-255. */
  pick: RGB | null;
  /** Adds a double foil rule round the edge. */
  border: boolean;
  foil: FoilKey;
  ground: Ground;
  shape: ShapeKey;
  /** Emboss blur in map pixels. The original uses 1. */
  softness: number;
  look: FoilLook;
}

export const DEFAULT_LOOK: FoilLook = { relief: 2.6, crinkle: 0.3, shine: 1, lampHeight: 0.27, grain: 1 };

export const DEFAULT_SETTINGS: FoilSettings = {
  mode: "details",
  amount: FOIL_MODES.details.defaultAmount,
  pick: null,
  border: false,
  foil: "gold",
  ground: "transparent",
  shape: "original",
  softness: 1,
  look: DEFAULT_LOOK,
};

/** Fills gaps in partial settings (from props or saved JSON) and clamps values to valid ranges. */
export type FoilSettingsInput = Partial<Omit<FoilSettings, "look">> & { look?: Partial<FoilLook> };

export function resolveSettings(partial?: FoilSettingsInput): FoilSettings {
  const s = { ...DEFAULT_SETTINGS, ...partial, look: { ...DEFAULT_LOOK, ...partial?.look } };
  if (!(s.mode in FOIL_MODES)) s.mode = DEFAULT_SETTINGS.mode;
  if (!(s.foil in FOILS)) s.foil = DEFAULT_SETTINGS.foil;
  if (!(s.shape in SHAPES)) s.shape = DEFAULT_SETTINGS.shape;
  if (s.ground !== "transparent" && s.ground !== "keep" && !(s.ground in PAPERS)) s.ground = DEFAULT_SETTINGS.ground;
  const [lo, hi] = FOIL_MODES[s.mode].range;
  s.amount = Math.min(hi, Math.max(lo, Number(s.amount) || FOIL_MODES[s.mode].defaultAmount));
  s.softness = Math.min(20, Math.max(0, Number(s.softness) || 0));
  return s;
}

/** Key of everything that changes the baked maps. Look values are excluded on purpose. */
export function mapKey(s: FoilSettings): string {
  return JSON.stringify([s.mode, s.amount, s.pick, s.border, s.foil, s.ground, s.shape, s.softness]);
}
