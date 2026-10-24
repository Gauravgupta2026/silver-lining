import type { GlyphSetKey } from "./crtSettings";
import { CELL_TAPS } from "./crtShader";

/** Glyph cell in the atlas, px. The ratio is a monospace character's. */
export const GLYPH_CELL = { w: 16, h: 28 } as const;
export const CELL_ASPECT = GLYPH_CELL.w / GLYPH_CELL.h;
/** Source texels per cell across; keeps cell averaging cheap and alias-free. */
const SOURCE_TEXELS_PER_CELL = CELL_TAPS.x;
const MAX_SOURCE_SIDE = 2048;
const MIN_SOURCE_SIDE = 128;
/** Width in px of the border strip used to guess whether the picture sits on a light page. */
const BORDER_PROBE = 32;
/** A picture whose border is lighter than this is treated as "on paper". */
export const LIGHT_BORDER = 0.55;

const ASCII_RAMP = " .:-=+*#%@";
const BLOCK_LEVELS = 8;
const DOT_LEVELS = 9;

export interface PreparedSource {
  canvas: HTMLCanvasElement;
  /** Width over height of the original picture. */
  aspect: number;
  /** Mean luminance 0-1 of the picture's outer border. */
  borderLuma: number;
}

const luma = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Text and blocks use tall monospace cells; dots need square cells to stay round. */
export function cellShape(kind: GlyphSetKey) {
  return kind === "dots" ? 1 : CELL_ASPECT;
}

/** Number of cell rows for a picture. */
export function cellRows(columns: number, aspect: number, kind: GlyphSetKey) {
  // Cell height = width / shape, so a tall cell (shape < 1) means fewer rows.
  return Math.max(1, Math.round((columns * cellShape(kind)) / aspect));
}

/**
 * Flattens the picture on white and scales it to a few texels per cell. Transparent art is
 * treated as ink on paper, which the "auto" invert then turns into light on glass.
 */
export function prepareSource(image: HTMLImageElement, columns: number): PreparedSource {
  const nw = image.naturalWidth || image.width;
  const nh = image.naturalHeight || image.height;
  const aspect = nw / nh;
  const width = Math.round(Math.min(MAX_SOURCE_SIDE, Math.max(MIN_SOURCE_SIDE, columns * SOURCE_TEXELS_PER_CELL)));
  const height = Math.max(1, Math.round(width / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas is not available");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);

  const probe = Math.min(BORDER_PROBE, Math.floor(Math.min(width, height) / 4));
  let sum = 0;
  let count = 0;
  const strips: [number, number, number, number][] = [
    [0, 0, width, probe],
    [0, height - probe, width, probe],
    [0, probe, probe, height - 2 * probe],
    [width - probe, probe, probe, height - 2 * probe],
  ];
  for (const [x, y, w, h] of strips) {
    if (w <= 0 || h <= 0) continue;
    const data = ctx.getImageData(x, y, w, h).data;
    for (let i = 0; i < data.length; i += 4) {
      sum += luma(data[i], data[i + 1], data[i + 2]);
      count++;
    }
  }
  return { canvas, aspect, borderLuma: count ? sum / count : 0.5 };
}

export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  count: number;
  /** Dot grids look right only with every second row offset. */
  stagger: boolean;
}

/** One glyph per column, from empty to dense. Coverage is in the red channel. */
export function buildGlyphAtlas(kind: GlyphSetKey): GlyphAtlas {
  const { w, h } = GLYPH_CELL;
  const count = kind === "ascii" ? ASCII_RAMP.length : kind === "blocks" ? BLOCK_LEVELS : DOT_LEVELS;
  const canvas = document.createElement("canvas");
  canvas.width = w * count;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, h);
  ctx.fillStyle = "#fff";

  if (kind === "ascii") {
    ctx.font = `700 ${Math.round(h * 0.82)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    [...ASCII_RAMP].forEach((ch, i) => ctx.fillText(ch, i * w + w / 2, h * 0.78));
  } else if (kind === "blocks") {
    // Solid blocks that gain weight. A one-pixel gutter keeps the cell grid readable.
    for (let i = 0; i < count; i++) {
      ctx.globalAlpha = i / (count - 1);
      ctx.fillRect(i * w + 1, 1, w - 2, h - 2);
    }
    ctx.globalAlpha = 1;
  } else {
    // Circles whose area grows with brightness. Dots render in square cells, so the atlas cell
    // is squeezed on screen: stretch each ellipse the opposite way to keep it round.
    const maxRadius = 0.54;
    for (let i = 1; i < count; i++) {
      const r = maxRadius * Math.sqrt(i / (count - 1));
      ctx.beginPath();
      ctx.ellipse(i * w + w / 2, h / 2, r * w, r * h, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return { canvas, count, stagger: kind === "dots" };
}
