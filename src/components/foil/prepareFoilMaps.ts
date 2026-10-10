/**
 * CPU pre-pass: turns a plain illustration into the two textures the foil shader reads.
 * A faithful port of bubbbly.com/foil-studio's pipeline, plus background cut-out for the web.
 *
 * - print: what the paper shows. Inside the foil it is repainted in the foil ink, scaled by the
 *   art's own luminance so the drawing's shading survives as the foil's emboss.
 * - fx:    R = foil mask, G = pearl (holographic only), B = height. The shader differentiates B to
 *   bend the surface normal, which is what makes stroke edges catch the light.
 *
 * Work is split in three cached layers so slider drags stay cheap:
 *   analyse() per image+shape  ->  rawScore() per mode(+pick)  ->  composeMaps() per settings.
 */

import { FOILS, PAPERS, SHAPES, type FoilSettings, type RGB, type ShapeKey } from "./foilSettings";

export interface FoilMaps {
  print: HTMLCanvasElement | HTMLImageElement;
  fx: HTMLCanvasElement | HTMLImageElement;
  width: number;
  height: number;
}

/** Longest side of the working maps (the original uses 1280). */
const MAP_SIZE = 1280;
/** "details": radius of the surrounding-luminance blur, as a share of the longest side. */
const DETAIL_SURROUND_SHARE = 0.009;
/** "darks": blur radius before ranking darkness, as a share of the longest side. */
const DARKS_BLUR_SHARE = 0.004;
/** Specks smaller than this share of the image area are dropped from the mask. */
const MIN_SPECK_SHARE = 12e-5;
/** Ground detection: colour distance (0-255 RGB) that still counts as background. */
const GROUND_NEAR = [24, 64] as const;
const GROUND_EXACT = [10, 22] as const;
/** Border rule: inset and stroke width as shares of the shorter side. */
const RIM_INSET = 0.045;
const RIM_WIDTH = 0.0075;

const LUMA = [0.299, 0.587, 0.114] as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Separable box blur, `passes` times (3 passes ≈ Gaussian). Edges clamp. */
function blur(src: Float32Array, w: number, h: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(0, Math.round(radius));
  const a = Float32Array.from(src);
  if (r === 0) return a;
  const b = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = a[row] * (r + 1);
      for (let i = 1; i <= r; i++) sum += a[row + Math.min(i, w - 1)];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum * inv;
        sum += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = b[x] * (r + 1);
      for (let i = 1; i <= r; i++) sum += b[Math.min(i, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum * inv;
        sum += b[Math.min(y + r + 1, h - 1) * w + x] - b[Math.max(y - r, 0) * w + x];
      }
    }
  }
  return a;
}

/** 3×3 separable min or max filter (erode / dilate). */
function rank(src: Float32Array, w: number, h: number, fn: (a: number, b: number, c: number) => number) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = fn(src[x > 0 ? i - 1 : i], src[i], src[x < w - 1 ? i + 1 : i]);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = fn(tmp[y > 0 ? i - w : i], tmp[i], tmp[y < h - 1 ? i + w : i]);
    }
  return out;
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
});

/** sRGB (0-255) → Oklab. Perceptual, so "how close a colour" behaves evenly across hues. */
function oklab(r: number, g: number, b: number): [number, number, number] {
  const lr = SRGB_TO_LINEAR[r], lg = SRGB_TO_LINEAR[g], lb = SRGB_TO_LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

interface GroundInfo {
  rgb: [number, number, number];
  /** True when the border is mostly one light, low-chroma colour: safe to cut out or repaint. */
  plain: boolean;
}

export interface Analysis {
  w: number;
  h: number;
  /** Pixels flattened on white, RGBA. */
  px: Uint8ClampedArray;
  /** Source alpha 0..1, so transparent PNGs stay transparent. */
  alpha: Float32Array;
  lum: Float32Array;
  ground: GroundInfo;
  cache: Map<string, Float32Array>;
}

/** Most common quantised border colour, and whether it is plain enough to treat as background. */
function findGround(px: Uint8ClampedArray, w: number, h: number): GroundInfo {
  const border: number[] = [];
  for (let x = 0; x < w; x += 2) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += 2) border.push(y * w, y * w + w - 1);
  const bin = (i: number) => (px[4 * i] >> 4) * 256 + (px[4 * i + 1] >> 4) * 16 + (px[4 * i + 2] >> 4);
  const counts = new Map<number, number>();
  for (const i of border) counts.set(bin(i), (counts.get(bin(i)) ?? 0) + 1);
  const top = [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const rgb: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (const i of border)
    if (bin(i) === top) {
      for (let c = 0; c < 3; c++) rgb[c] += px[4 * i + c];
      n++;
    }
  for (let c = 0; c < 3; c++) rgb[c] /= n;
  const near = border.filter((i) => Math.hypot(px[4 * i] - rgb[0], px[4 * i + 1] - rgb[1], px[4 * i + 2] - rgb[2]) < 28).length;
  const lum = (LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]) / 255;
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  return { rgb, plain: near / border.length > 0.4 && lum > 0.75 && chroma < 45 };
}

/** Cache per image element: the analysis does not depend on any setting except shape. */
const analyses = new WeakMap<object, Map<ShapeKey, Analysis>>();

export function analyse(image: HTMLImageElement | ImageBitmap, shape: ShapeKey): Analysis {
  let perShape = analyses.get(image);
  if (!perShape) analyses.set(image, (perShape = new Map()));
  const hit = perShape.get(shape);
  if (hit) return hit;

  const iw = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const ih = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  const imgAspect = iw / ih;
  const aspect = SHAPES[shape].aspect || imgAspect;
  const w = aspect >= 1 ? MAP_SIZE : Math.round(MAP_SIZE * aspect);
  const h = aspect >= 1 ? Math.round(MAP_SIZE / aspect) : MAP_SIZE;
  // Centre-crop the source to the target aspect.
  const sw = imgAspect > aspect ? ih * aspect : iw;
  const sh = imgAspect > aspect ? ih : iw / aspect;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;

  const raw = makeCanvas(w, h).getContext("2d", { willReadFrequently: true })!;
  raw.imageSmoothingQuality = "high";
  raw.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
  const src = raw.getImageData(0, 0, w, h).data;

  const n = w * h;
  const px = new Uint8ClampedArray(4 * n);
  const alpha = new Float32Array(n);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = src[4 * i + 3] / 255;
    alpha[i] = a;
    // Flatten on white so the analysis treats transparency as paper.
    for (let c = 0; c < 3; c++) px[4 * i + c] = src[4 * i + c] * a + 255 * (1 - a);
    px[4 * i + 3] = 255;
    lum[i] = (LUMA[0] * px[4 * i] + LUMA[1] * px[4 * i + 1] + LUMA[2] * px[4 * i + 2]) / 255;
  }
  const result: Analysis = { w, h, px, alpha, lum, ground: findGround(px, w, h), cache: new Map() };
  perShape.set(shape, result);
  return result;
}

/** Average colour in a 7×7 patch at normalised (u, v), v down. Used by the colour picker. */
export function samplePick(an: Analysis, u: number, v: number): RGB {
  const cx = Math.round(clamp01(u) * (an.w - 1));
  const cy = Math.round(clamp01(v) * (an.h - 1));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - 3); y <= Math.min(an.h - 1, cy + 3); y++)
    for (let x = Math.max(0, cx - 3); x <= Math.min(an.w - 1, cx + 3); x++) {
      for (let c = 0; c < 3; c++) sum[c] += an.px[(y * an.w + x) * 4 + c];
      n++;
    }
  return [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
}

/**
 * Soft background mask: flood-filled from the border through colours near the ground, plus any
 * pixel that is almost exactly the ground colour (gaps enclosed by the art). All 0 when not plain.
 */
function groundMask(an: Analysis): Float32Array {
  const cached = an.cache.get("ground");
  if (cached) return cached;
  const { w, h, px, ground } = an;
  const n = w * h;
  if (!ground.plain) {
    const none = new Float32Array(n);
    an.cache.set("ground", none);
    return none;
  }
  const [r, g, b] = ground.rgb;
  const near = new Float32Array(n);
  const exact = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(px[4 * i] - r, px[4 * i + 1] - g, px[4 * i + 2] - b);
    near[i] = 1 - smoothstep(GROUND_NEAR[0], GROUND_NEAR[1], d);
    exact[i] = 1 - smoothstep(GROUND_EXACT[0], GROUND_EXACT[1], d);
  }
  const reached = new Float32Array(n);
  const stack: number[] = [];
  const visit = (i: number) => {
    if (!reached[i] && near[i] > 0.35) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < w * (h - 1)) visit(i + w);
  }
  const grown = rank(rank(reached, w, h, Math.max), w, h, Math.max);
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = Math.max(exact[i], near[i] * grown[i]);
  const soft = blur(mask, w, h, 1, 1);
  an.cache.set("ground", soft);
  return soft;
}

/** Unthresholded "how foil-like" score per pixel, cached per mode (and picked colour). */
function rawScore(an: Analysis, mode: FoilSettings["mode"], pick: RGB | null): Float32Array {
  const key = mode === "colour" ? `colour ${pick?.join(",")}` : mode;
  const hit = an.cache.get(key);
  if (hit) return hit;
  const { w, h, lum, px } = an;
  const longest = Math.max(w, h);
  let out: Float32Array;
  if (mode === "details") {
    const fine = blur(lum, w, h, 2, 2);
    const surround = blur(lum, w, h, Math.max(2, Math.round(DETAIL_SURROUND_SHARE * longest)));
    out = new Float32Array(lum.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, surround[i] - fine[i]);
  } else if (mode === "darks") {
    out = blur(lum, w, h, Math.max(2, Math.round(DARKS_BLUR_SHARE * longest)), 3);
    for (let i = 0; i < out.length; i++) out[i] = 1 - out[i];
  } else if (mode === "colour") {
    const [tl, ta, tb] = oklab(...(pick ?? [0, 0, 0]));
    out = new Float32Array(lum.length);
    for (let i = 0; i < out.length; i++) {
      const [l, a, b] = oklab(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
      out[i] = 1 - Math.hypot(l - tl, a - ta, b - tb);
    }
    out = blur(out, w, h, 1, 1);
  } else {
    // "all": whatever is neither background nor transparent.
    const ground = groundMask(an);
    out = new Float32Array(lum.length);
    for (let i = 0; i < out.length; i++) out[i] = an.alpha[i] * (1 - ground[i]);
  }
  an.cache.set(key, out);
  return out;
}

/** Value above which the top `share` of pixels lie (2048-bin histogram). */
function percentile(values: Float32Array, share: number) {
  let top = 1e-6;
  for (const v of values) if (v > top) top = v;
  const bins = new Uint32Array(2048);
  for (const v of values) bins[Math.min(2047, Math.floor((Math.max(0, v) / top) * 2047))]++;
  const want = share * values.length;
  let seen = 0;
  for (let b = 2047; b >= 0; b--) if ((seen += bins[b]) >= want) return { at: (b / 2047) * top, top };
  return { at: 0, top };
}

/** Keeps connected regions of at least `minSize` px (8-connected), with a 2 px soft margin. */
function dropSpecks(mask: Float32Array, w: number, h: number, minSize: number) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] < 0.5 || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (label[j] < 0 && mask[j] >= 0.5) {
            label[j] = id;
            stack.push(j);
          }
        }
    }
    sizes.push(size);
  }
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < keep.length; i++) {
    if (label[i] < 0 || sizes[label[i]] < minSize) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) keep[ny * w + nx] = 1;
      }
  }
  const out = new Float32Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = keep[i] ? mask[i] : 0;
  return out;
}

/** Double foil rule round the edge, as an alpha mask. */
function rimMask(w: number, h: number) {
  const ctx = makeCanvas(w, h).getContext("2d", { willReadFrequently: true })!;
  const short = Math.min(w, h);
  const inset = RIM_INSET * short;
  const width = RIM_WIDTH * short;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = width;
  ctx.strokeRect(inset, inset, w - 2 * inset, h - 2 * inset);
  ctx.lineWidth = 0.4 * width;
  const inner = inset + 2.4 * width;
  ctx.strokeRect(inner, inner, w - 2 * inner, h - 2 * inner);
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[4 * i + 3] / 255;
  return out;
}

/** Final foil coverage 0..1 for the given settings. */
export function foilMask(an: Analysis, s: FoilSettings): Float32Array {
  const { w, h } = an;
  let mask: Float32Array = new Float32Array(w * h);
  if (s.mode === "colour" && !s.pick) {
    // Nothing picked yet: no foil, just the art.
  } else if (s.mode === "all") {
    mask = Float32Array.from(rawScore(an, s.mode, s.pick));
  } else {
    const score = rawScore(an, s.mode, s.pick);
    if (s.mode === "colour") {
      const t = 1 - (0.03 + 0.32 * s.amount);
      for (let i = 0; i < mask.length; i++) mask[i] = smoothstep(t - 0.025, t + 0.025, score[i]);
    } else {
      const { at, top } = percentile(score, s.amount);
      const floor = s.mode === "details" ? 0.07 * Math.max(0, 1 - s.amount / 0.4) : 0;
      const cut = Math.max(at, 0.03 * top, floor);
      const band = 0.04 * cut + 0.002 * top;
      for (let i = 0; i < mask.length; i++) mask[i] = smoothstep(cut - band, cut + band, score[i]);
    }
    // Open (erode → dilate) to clean ragged edges, drop specks, soften by a pixel.
    mask = blur(dropSpecks(rank(rank(mask, w, h, Math.min), w, h, Math.max), w, h, w * h * MIN_SPECK_SHARE), w, h, 1, 1);
    // Never put foil on transparent pixels.
    for (let i = 0; i < mask.length; i++) mask[i] *= an.alpha[i];
  }
  if (s.ground === "transparent") {
    // Blurred modes spill a fringe onto the background; a cut-out background must stay clear.
    const ground = groundMask(an);
    for (let i = 0; i < mask.length; i++) mask[i] *= 1 - ground[i];
  }
  if (s.border) {
    const rim = rimMask(w, h);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.max(mask[i], rim[i]);
  }
  return mask;
}

export function composeMaps(an: Analysis, s: FoilSettings): FoilMaps {
  const { w, h, px, lum, alpha, ground } = an;
  const n = w * h;
  const foil = foilMask(an, s);
  const finish = FOILS[s.foil];
  const holo = "holo" in finish && finish.holo;
  const ink = finish.ink;

  const gMask = ground.plain && s.ground !== "keep" ? groundMask(an) : null;
  const paper = s.ground in PAPERS ? PAPERS[s.ground as keyof typeof PAPERS].rgb : null;
  const groundLum = (LUMA[0] * ground.rgb[0] + LUMA[1] * ground.rgb[1] + LUMA[2] * ground.rgb[2]) / 255;

  const soft = blur(foil, w, h, s.softness, 3);
  const lumFine = blur(lum, w, h, 2, 2);
  // Mean luminance under the foil, so the ink's shading is relative to this art.
  let lumSum = 0, foilSum = 0;
  for (let i = 0; i < n; i++) {
    lumSum += foil[i] * lum[i];
    foilSum += foil[i];
  }
  const meanLum = foilSum > 0 ? lumSum / foilSum : 0.5;

  const print = new ImageData(w, h);
  const fx = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = 4 * i;
      const d = foil[i];
      const l = lum[i];
      const shade = Math.min(1.25, Math.max(0.45, 1 + 0.7 * (l - meanLum)));
      let ir = ink[0] * shade, ig = ink[1] * shade, ib = ink[2] * shade;
      if (holo) {
        const phase = 2 * Math.PI * ((x / w) * 0.9 + (y / h) * 0.55);
        ir *= 0.82 + 0.3 * Math.cos(phase);
        ig *= 0.82 + 0.3 * Math.cos(phase - 2.07);
        ib *= 0.82 + 0.3 * Math.cos(phase - 4.15);
      }
      let r = px[o], g = px[o + 1], b = px[o + 2];
      let a = alpha[i];
      if (gMask) {
        const t = gMask[i] * (1 - d);
        if (paper) {
          // Repaint the ground in the paper stock, keeping the art's shading.
          const e = l / groundLum;
          r += (paper[0] * e - r) * t;
          g += (paper[1] * e - g) * t;
          b += (paper[2] * e - b) * t;
        } else {
          a *= 1 - t;
        }
      }
      print.data[o] = r + (ir - r) * d;
      print.data[o + 1] = g + (ig - g) * d;
      print.data[o + 2] = b + (ib - b) * d;
      print.data[o + 3] = 255 * a;

      const height = clamp01((0.6 * soft[i] + 0.5 * (l - lumFine[i]) * d) * 0.85 + 0.08);
      fx.data[o] = 255 * d;
      fx.data[o + 1] = holo ? 215 * d : 0;
      fx.data[o + 2] = 255 * height;
      fx.data[o + 3] = 255;
    }
  const printCanvas = makeCanvas(w, h);
  const fxCanvas = makeCanvas(w, h);
  printCanvas.getContext("2d")!.putImageData(print, 0, 0);
  fxCanvas.getContext("2d")!.putImageData(fx, 0, 0);
  return { print: printCanvas, fx: fxCanvas, width: w, height: h };
}
