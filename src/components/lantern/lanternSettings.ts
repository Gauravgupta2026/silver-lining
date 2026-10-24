/**
 * Everything that describes one sun lantern: a luminous sun inside a drum of fluted (reeded) glass.
 * The studio edits a LanternSettings object and the site renders the same object.
 */

export type RGB = readonly [number, number, number];

/** Colours are sRGB 0-255. The renderer converts them to linear light. */
export interface LanternLook {
  name: string;
  hint: string;
  /** Unlit wall colour. */
  wall: RGB;
  /** Hottest part of the sun. */
  core: RGB;
  /** Sun colour at its edge. */
  rim: RGB;
  /** Colour of the glow round the sun. */
  halo: RGB;
  /** Colour of the light that lands on the wall. */
  beam: RGB;
  /** Lacquer on the lid, band and foot. */
  lacquer: RGB;
  /** Metal rings and handle. */
  metal: RGB;
  /** What the glass absorbs, 0 = nothing. Warm tints absorb blue most. */
  glass: RGB;
}

export const LANTERN_LOOKS = {
  festival: {
    name: "Festival",
    hint: "Red silk, gold light, a white-hot sun.",
    wall: [196, 24, 16],
    core: [255, 246, 220],
    rim: [255, 150, 40],
    halo: [255, 128, 32],
    beam: [255, 206, 112],
    lacquer: [190, 20, 14],
    metal: [232, 182, 84],
    glass: [14, 58, 120],
  },
  dusk: {
    name: "Dusk",
    hint: "Violet cloth with a rose-orange sun.",
    wall: [64, 24, 128],
    core: [255, 240, 226],
    rim: [255, 104, 64],
    halo: [255, 84, 124],
    beam: [255, 158, 146],
    lacquer: [72, 28, 140],
    metal: [230, 160, 140],
    glass: [40, 90, 40],
  },
  lagoon: {
    name: "Lagoon",
    hint: "Deep teal water, a cool cyan sun.",
    wall: [8, 92, 104],
    core: [236, 255, 255],
    rim: [56, 224, 208],
    halo: [58, 208, 255],
    beam: [150, 244, 230],
    lacquer: [10, 98, 108],
    metal: [208, 220, 224],
    glass: [120, 40, 10],
  },
  noir: {
    name: "Noir",
    hint: "Black room, white sun, silver glass.",
    wall: [26, 26, 32],
    core: [255, 255, 255],
    rim: [255, 255, 255],
    halo: [206, 218, 255],
    beam: [255, 255, 255],
    lacquer: [24, 24, 30],
    metal: [170, 176, 184],
    glass: [0, 0, 0],
  },
} as const satisfies Record<string, LanternLook>;

export type LanternLookKey = keyof typeof LANTERN_LOOKS;

export const TURN_MODES = {
  glass: { name: "Glass", hint: "The fluted ring turns. The sun stays in the middle." },
  sun: { name: "Sun", hint: "The ring stands still. The sun orbits inside it." },
  both: { name: "Both", hint: "Ring and sun turn at their own speeds." },
} as const;
export type TurnMode = keyof typeof TURN_MODES;

export const FRAMES = {
  portrait: { name: "Portrait", aspect: 3 / 4 },
  square: { name: "Square", aspect: 1 },
  wide: { name: "Wide", aspect: 16 / 10 },
} as const;
export type FrameKey = keyof typeof FRAMES;

export const TOGGLES = {
  on: { name: "On", hint: "" },
  off: { name: "Off", hint: "" },
} as const;
export type Toggle = keyof typeof TOGGLES;

export interface LanternSettings {
  look: LanternLookKey;
  turns: TurnMode;
  frame: FrameKey;
  /** Sun radius as a share of the glass radius. */
  sunSize: number;
  sunBrightness: number;
  /** Streaks that fan out of the sun. */
  rays: number;
  /** Small, slow changes in brightness, like a flame. */
  flicker: number;
  bloom: number;
  /** Flutes round the whole ring. */
  flutes: number;
  /** Steepest slope of a flute, in degrees. */
  depth: number;
  /** Refractive index of the glass. */
  glassIndex: number;
  /** How far red and blue bend apart. */
  dispersion: number;
  /** Soft, milky scatter inside the glass. */
  frost: number;
  /** Glass wall thickness as a share of the radius. */
  thickness: number;
  /** A second layer of glass rods inside the ring. It turns against the ring and makes waves. */
  rodLayer: Toggle;
  /** Rods round the whole inner layer. */
  rods: number;
  /** Steepest slope of a rod, in degrees. */
  rodDepth: number;
  /** Rod layer speed as a multiple of the ring speed. Negative turns the other way. */
  rodSpin: number;
  /** How far the rods bend sideways as they rise. This makes the crests and valleys. */
  wave: number;
  /** Gold line art on the lacquer: key fret, medallions, scrolls. */
  ornament: number;
  /** Ring speed in turns per minute. Negative turns the other way. */
  glassSpeed: number;
  /** Sun orbit speed in turns per minute. */
  sunSpeed: number;
  /** How far from the middle the sun orbits, as a share of the glass radius. */
  sunOrbit: number;
  /** Distance from the lantern axis to the wall behind it. */
  wallDistance: number;
  /** Strength of the light patterns thrown on the wall. */
  caustics: number;
  exposure: number;
  grain: number;
}

export type LanternSettingsInput = Partial<LanternSettings>;

export const NUMERIC_RANGES = {
  sunSize: { min: 0.12, max: 0.5, step: 0.005 },
  sunBrightness: { min: 0.3, max: 3, step: 0.01 },
  rays: { min: 0, max: 1, step: 0.01 },
  flicker: { min: 0, max: 1, step: 0.01 },
  bloom: { min: 0, max: 2.5, step: 0.01 },
  flutes: { min: 16, max: 120, step: 1 },
  depth: { min: 0, max: 70, step: 1 },
  glassIndex: { min: 1.2, max: 2, step: 0.01 },
  dispersion: { min: 0, max: 0.06, step: 0.001 },
  frost: { min: 0, max: 1, step: 0.01 },
  thickness: { min: 0.02, max: 0.15, step: 0.005 },
  rods: { min: 12, max: 140, step: 1 },
  rodDepth: { min: 0, max: 70, step: 1 },
  rodSpin: { min: -3, max: 3, step: 0.05 },
  wave: { min: 0, max: 1, step: 0.01 },
  ornament: { min: 0, max: 1, step: 0.01 },
  glassSpeed: { min: -20, max: 20, step: 0.1 },
  sunSpeed: { min: -30, max: 30, step: 0.1 },
  sunOrbit: { min: 0, max: 0.7, step: 0.01 },
  wallDistance: { min: 1.3, max: 4, step: 0.01 },
  caustics: { min: 0, max: 2.5, step: 0.01 },
  exposure: { min: 0.4, max: 2.5, step: 0.01 },
  grain: { min: 0, max: 1, step: 0.01 },
} as const satisfies Record<string, { min: number; max: number; step: number }>;

type NumericKey = keyof typeof NUMERIC_RANGES;

export const DEFAULT_LANTERN_SETTINGS: LanternSettings = {
  look: "festival",
  turns: "glass",
  frame: "portrait",
  sunSize: 0.36,
  sunBrightness: 1,
  rays: 0.4,
  flicker: 0.25,
  bloom: 1,
  flutes: 64,
  depth: 18,
  glassIndex: 1.52,
  dispersion: 0.012,
  frost: 0.4,
  thickness: 0.07,
  rodLayer: "on",
  rods: 75,
  rodDepth: 22,
  rodSpin: -1.4,
  wave: 0.3,
  ornament: 1,
  glassSpeed: 4,
  sunSpeed: 8,
  sunOrbit: 0.36,
  wallDistance: 2,
  caustics: 1,
  exposure: 1,
  grain: 0.25,
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Fills gaps with defaults and clamps every number into its slider range. Safe on untrusted JSON. */
export function resolveLanternSettings(input?: LanternSettingsInput | null): LanternSettings {
  const merged: LanternSettings = { ...DEFAULT_LANTERN_SETTINGS, ...(input ?? {}) };
  if (!(merged.look in LANTERN_LOOKS)) merged.look = DEFAULT_LANTERN_SETTINGS.look;
  if (!(merged.turns in TURN_MODES)) merged.turns = DEFAULT_LANTERN_SETTINGS.turns;
  if (!(merged.frame in FRAMES)) merged.frame = DEFAULT_LANTERN_SETTINGS.frame;
  if (!(merged.rodLayer in TOGGLES)) merged.rodLayer = DEFAULT_LANTERN_SETTINGS.rodLayer;
  for (const key of Object.keys(NUMERIC_RANGES) as NumericKey[]) {
    const { min, max } = NUMERIC_RANGES[key];
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) ? clamp(value, min, max) : DEFAULT_LANTERN_SETTINGS[key];
  }
  // The flute pattern must close on itself, so the count is a whole number.
  merged.flutes = Math.round(merged.flutes);
  merged.rods = Math.round(merged.rods);
  return merged;
}
