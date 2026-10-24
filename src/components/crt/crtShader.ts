/**
 * CRT screen shading in three programs. A real tube adds its glow to the light the beam already
 * made, so the order matters:
 *
 *  1. SCENE   picture -> cells (mosaic, ASCII or dots) -> tone curve -> colour ramp.
 *  2. BLUR    a pyramid of three blurred copies of the bright parts of the scene (the bloom).
 *  3. COMPOSITE  barrel curve -> phosphor mask -> add bloom -> highlight roll-off -> grain -> bezel.
 *
 * The mask multiplies only the sharp scene. Bloom is added after it, so mid-tones show the stripes
 * and blown-out whites hide them, as on a real tube.
 */

export const CRT_VERTEX = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Cell sampling taps across one cell, columns by rows. Keep in step with the loops below. */
export const CELL_TAPS = { x: 4, y: 3 } as const;

export const CRT_SCENE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uSrc;      // the picture, flattened on white, v = 0 at the bottom
uniform sampler2D uGlyphs;   // glyph atlas, coverage in r, one glyph per column, dark to dense
uniform vec2 uCells;         // columns, rows
uniform float uGlyphCount;
uniform float uGlyphMix;
uniform float uStagger;      // 1 offsets every second row by half a cell
uniform float uInvert;
uniform float uExposure;
uniform float uContrast;
uniform vec3 uRamp[6];
${HASH}
vec3 ramp(float l) {
  vec3 c = uRamp[0];
  for (int i = 0; i < 5; i++) {
    c = mix(c, uRamp[i + 1], clamp(l * 5.0 - float(i), 0.0, 1.0));
  }
  return c;
}

void main() {
  vec2 g = vUv * uCells;
  float shift = uStagger * 0.5 * mod(floor(g.y), 2.0);
  vec2 gs = vec2(g.x - shift, g.y);
  vec2 id = floor(gs);
  vec2 f = fract(gs);
  vec2 centre = vec2(id.x + 0.5 + shift, id.y + 0.5) / uCells;

  // Box-average the picture over the cell so thin lines survive as a dimmer cell, not a hole.
  vec3 acc = vec3(0.0);
  for (int j = 0; j < ${CELL_TAPS.y}; j++) {
    for (int i = 0; i < ${CELL_TAPS.x}; i++) {
      vec2 o = vec2((float(i) + 0.5) / ${CELL_TAPS.x}.0 - 0.5, (float(j) + 0.5) / ${CELL_TAPS.y}.0 - 0.5) / uCells;
      acc += texture2D(uSrc, centre + o).rgb;
    }
  }
  acc /= ${CELL_TAPS.x * CELL_TAPS.y}.0;

  float l = dot(acc, vec3(0.2126, 0.7152, 0.0722));
  l = mix(l, 1.0 - l, uInvert);
  l = clamp((l * uExposure - 0.5) * uContrast + 0.5, 0.0, 1.0);

  float idx = floor(l * (uGlyphCount - 1.0) + 0.5);
  vec2 gu = vec2((idx + clamp(f.x, 0.04, 0.96)) / uGlyphCount, 1.0 - clamp(f.y, 0.03, 0.97));
  float cover = texture2D(uGlyphs, gu).r;
  float shaped = cover * clamp(l * 1.35 + 0.12, 0.0, 1.0);
  float lum = mix(l, shaped, uGlyphMix);

  gl_FragColor = vec4(ramp(lum), lum);
}
`;

export const CRT_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec2 uDir;           // one texel of the target, along the blur axis
uniform float uExtract;      // 1 on the first pass: keep only the bright parts
uniform float uThreshold;

vec3 fetch(vec2 uv) {
  vec4 t = texture2D(uTex, uv);
  return uExtract > 0.5 ? t.rgb * smoothstep(uThreshold, 1.0, t.a) : t.rgb;
}

void main() {
  vec3 c = fetch(vUv) * 0.2270270270;
  c += (fetch(vUv + uDir * 1.3846153846) + fetch(vUv - uDir * 1.3846153846)) * 0.3162162162;
  c += (fetch(vUv + uDir * 3.2307692308) + fetch(vUv - uDir * 3.2307692308)) * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const CRT_COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform sampler2D uB3;
uniform vec2 uCanvas;        // device px
uniform vec2 uPic;           // cell columns, rows
uniform float uCurve;
uniform float uBezel;        // share of the width
uniform float uMaskKind;     // 0 none, 1 stripes, 2 dots
uniform float uMaskCols;
uniform float uMaskRows;
uniform float uMaskPeriod;   // device px per stripe or dot
uniform float uMaskStrength;
uniform float uScan;
uniform float uGain;
uniform float uBloom;
uniform float uGrain;
uniform float uGrainPx;
uniform float uAberration;
uniform float uSparkle;
uniform vec3 uSpeckColour;
uniform float uFocus;
uniform float uFlicker;
uniform float uRoll;
uniform float uGlitch;
uniform float uLens;
uniform float uTime;
uniform float uPower;        // 0 off ... 1 fully on
uniform float uCalm;         // 1 freezes all motion (reduced motion)
uniform vec3 uPointer;       // x, y in canvas uv, z presence 0..1
${HASH}
const float TAU = 6.2831853;
const float CORNER = 0.035;
// Phosphor white tops out just under clipping, so grain still shows in blown-out areas.
const float WHITE_CAP = 0.965;

float stripe(float x) {
  return pow(0.5 + 0.5 * cos(TAU * x), 1.5);
}

// Rare bright cells in dark areas, re-rolled four times a second. They skip the beam softening,
// so they stay sharp, and each colour channel finds its own cell, which gives the fringe.
float speck(vec2 uv, float dark) {
  vec2 id = floor(uv * uPic);
  float h = hash12(id + floor(uTime * 4.0) * 1.37 * (1.0 - uCalm));
  float hit = step(1.0 - uSparkle * 0.008 * dark * dark, h);
  return hit * (0.55 + 0.45 * hash12(id + 7.7));
}

// A beam is never perfectly focused: each cell leaks a little into its neighbours.
vec3 beam(vec2 uv) {
  vec2 dx = vec2(uFocus * 0.8 / uPic.x, 0.0);
  vec2 dy = vec2(0.0, uFocus * 0.8 / uPic.y);
  return texture2D(uScene, uv).rgb * 0.36
    + (texture2D(uScene, uv + dx).rgb + texture2D(uScene, uv - dx).rgb
    +  texture2D(uScene, uv + dy).rgb + texture2D(uScene, uv - dy).rgb) * 0.16;
}

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float asp = uCanvas.x / uCanvas.y;

  // Glass: barrel-distort so the middle of each edge touches the canvas and the corners pull in.
  vec2 s = c * (1.0 + uCurve * dot(c, c)) / (1.0 + uCurve);
  vec2 q = abs(s) - vec2(1.0 - CORNER);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - CORNER;
  float aa = 3.0 / min(uCanvas.x, uCanvas.y);
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float depth = -d;

  // The picture sits inside the bezel without cropping.
  float bz = uBezel * 2.0;
  vec2 p = s / (1.0 - bz);

  // The cursor acts like a magnet near the glass: a gentle lens and a lift in brightness.
  vec2 dv = c - (uPointer.xy * 2.0 - 1.0);
  vec2 da = dv * vec2(asp, 1.0);
  float lens = uPointer.z * uLens * exp(-dot(da, da) * 9.0);
  p -= dv * 0.1 * lens;
  vec2 pic = p * 0.5 + 0.5;

  // Rare horizontal tears, and a faint wobble in every line.
  float live = 1.0 - uCalm;
  float row = floor(pic.y * uPic.y);
  float burstWindow = floor(uTime * 2.5);
  float burst = step(0.965, hash12(vec2(burstWindow, 9.0))) * uGlitch * live;
  float tearRow = step(0.55, hash12(vec2(floor(row * 0.12), burstWindow)));
  pic.x += burst * tearRow * (hash12(vec2(row, floor(uTime * 20.0))) - 0.5) * 0.03;
  pic.x += uGlitch * live * 0.0005 * sin(pic.y * 70.0 + uTime * 2.0);

  // Convergence error: red and blue land a fraction of a cell apart, more toward the corners.
  float r2 = dot(c, c);
  float shift = (uAberration * 0.5 / uPic.x) * (0.45 + 0.9 * r2) + lens * 0.6 / uPic.x;
  vec3 sharp;
  sharp.r = beam(pic - vec2(shift, 0.0)).r;
  sharp.g = beam(pic).g;
  sharp.b = beam(pic + vec2(shift, 0.0)).b;

  float dark = 1.0 - dot(sharp, vec3(0.2126, 0.7152, 0.0722));
  vec3 sp = vec3(speck(pic - vec2(shift, 0.0), dark), speck(pic, dark), speck(pic + vec2(shift, 0.0), dark));
  sharp = max(sharp, sp * uSpeckColour);

  // Phosphor mask. Fades out when stripes would be thinner than a device pixel pair (moire).
  float fade = smoothstep(1.4, 3.2, uMaskPeriod);
  float amount = uMaskStrength * fade;
  vec3 mask = vec3(1.0);
  if (uMaskKind > 0.5 && uMaskKind < 1.5) {
    float ph = pic.x * uMaskCols;
    vec3 triad = vec3(stripe(ph), stripe(ph - 0.3333), stripe(ph - 0.6667));
    mask = mix(vec3(1.0), mix(vec3(stripe(ph)), triad, 0.15), amount) / mix(1.0, 0.375, amount);
  } else if (uMaskKind > 1.5) {
    vec2 gp = vec2(pic.x * uMaskCols, pic.y * uMaskRows);
    float off = 0.5 * mod(floor(gp.y), 2.0);
    vec2 cell = vec2(fract(gp.x - off) - 0.5, fract(gp.y) - 0.5);
    float edge = clamp(0.9 / uMaskPeriod, 0.04, 0.4);
    float dot_ = 1.0 - smoothstep(0.34 - edge, 0.34 + edge, length(cell));
    mask = mix(vec3(1.0), vec3(dot_), amount) / mix(1.0, 0.4, amount);
  }
  float scan = 1.0 - uScan * fade * (0.5 - 0.5 * cos(TAU * pic.y * uMaskRows));

  vec3 glow = texture2D(uB1, pic).rgb * 0.35 + texture2D(uB2, pic).rgb * 0.5 + texture2D(uB3, pic).rgb * 0.7;
  vec3 col = sharp * mask * scan * uGain + glow * uBloom;

  // Slow brightness drift, mains hum and a bright band rolling down the tube.
  float flick = 1.0 + live * uFlicker * (0.05 * (hash12(vec2(floor(uTime * 30.0), 1.0)) - 0.5) + 0.02 * sin(uTime * 2.1));
  float bar = exp(-pow((pic.y - fract(uTime * 0.11)) * 7.0, 2.0));
  col *= flick * (1.0 + live * uRoll * 0.18 * bar);
  col *= 1.0 + lens * 0.35;

  // Highlights roll off toward white instead of clipping to a flat colour.
  float peak = max(col.r, max(col.g, col.b));
  col = mix(col, vec3(peak), smoothstep(0.85, 1.7, peak));
  col *= 1.0 - 0.28 * smoothstep(0.3, 2.0, r2);
  col = min(col, vec3(WHITE_CAP));

  // Power on: a line opens sideways, then grows to the full height.
  float open = smoothstep(0.0, 0.3, uPower);
  float grow = smoothstep(0.3, 0.85, uPower);
  vec2 cp = c / vec2(max(open, 0.001), max(grow, 0.001));
  col *= step(abs(cp.x), 1.0) * step(abs(cp.y), 1.0) * (1.0 + (1.0 - uPower) * 2.5);

  // Bezel: dark glass rim, with a little bloom bleeding over it.
  float visible = smoothstep(bz * 0.55, bz * 1.45, depth);
  vec3 rim = mix(vec3(0.13, 0.14, 0.15), vec3(0.025), smoothstep(0.0, bz * 0.5 + 0.0001, depth));
  col = mix(rim + glow * uBloom * 0.18, col, visible);

  // Grain: triangular luma noise, a touch of colour, re-rolled 24 times a second.
  vec2 gp2 = floor(gl_FragCoord.xy / uGrainPx);
  float tq = floor(uTime * 24.0) * (1.0 - uCalm);
  float n = hash12(gp2 + tq * 17.13) + hash12(gp2.yx * 1.7 + tq * 3.7 + 11.0) - 1.0;
  vec3 tint = vec3(hash12(gp2 + 3.1 + tq), hash12(gp2 + 5.9 + tq), hash12(gp2 + 8.3 + tq)) - 0.5;
  col += (vec3(n) + tint * 0.35) * uGrain * 0.21;

  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;
