/**
 * Lantern shading in three programs (WebGL2, HDR).
 *
 *  1. SCENE      the wall, the lacquer caps and the fluted glass. Every pixel over the glass is a
 *                camera ray traced through the real optics: refract into the fluted face, refract
 *                out of the smooth inner face, pass the sun, refract through the back wall, then
 *                land on the lit wall. Red, green and blue use their own glass index.
 *  2. BLUR       a pyramid of blurred copies of the bright parts (bloom).
 *  3. COMPOSITE  scene + bloom, exposure, filmic tone curve, vignette, grain.
 *
 * The 2D optics notes in lanternPhysics.ts apply here: all rays stay in the horizontal plane, so
 * `vec2` ray maths below is (x, z). The world is orthographic, y up, camera on +z looking down -z.
 */

export const LANTERN_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/** World height of the lantern body, so the shader and the host agree on the framing. */
export const LAYOUT = {
  /** World y at the middle of the picture. */
  centerY: 0.34,
  /** World height of the picture. Width follows the frame's aspect ratio. */
  viewHeight: 3.9,
} as const;

const COMMON = /* glsl */ `
const float TAU = 6.28318531;
const float GLASS_BOTTOM = -0.45;
const float GLASS_TOP = 0.45;

// Render targets hold light in this form. Float targets (range 1) store it as is. 8-bit targets
// store sqrt(light / range), which spends their few levels where the eye needs them: the darks.
vec3 hdrEncode(vec3 c, float range) {
  return range > 1.0 ? sqrt(clamp(c / range, 0.0, 1.0)) : c;
}
vec3 hdrDecode(vec3 t, float range) {
  return range > 1.0 ? t * t * range : t;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

export const LANTERN_SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2 uRes;           // device px
uniform vec2 uHalfView;      // world half size of the picture
uniform float uCenterY;      // world y at the middle of the picture
uniform float uPx;           // world units per device px
uniform float uPhi;          // glass turn, radians
uniform float uFlutes;
uniform float uDepth;        // steepest flute slope, radians
uniform vec3 uIor;           // glass index for red, green, blue
uniform float uSpectral;     // 1 traces three indices, 0 traces one
uniform float uRods;         // 1 when the rod layer is on
uniform float uRodN;
uniform float uRodDepth;     // radians
uniform float uRodPhi;       // rod layer turn, radians
uniform float uWave;         // sideways wobble of the rods, in rod widths
uniform vec3 uRadii;         // outer shell inner face, rod outer face, rod inner face
uniform float uOrnament;     // 0 plain lacquer, 1 full gold line art
uniform vec3 uAbsorb;        // glass absorption per world unit
uniform float uFrost;
uniform vec3 uSun;           // x, height, z
uniform float uSunR;
uniform float uSunPower;
uniform vec3 uSunCore;
uniform vec3 uSunRim;
uniform vec3 uSunHalo;
uniform vec3 uBeam;
uniform float uRays;
uniform float uTime;
uniform float uWallDist;
uniform sampler2D uCaustic;
uniform float uCausticRange;
uniform float uCausticGain;
uniform float uWallGlow;
uniform vec3 uWall;
uniform vec3 uLacquer;
uniform vec3 uMetal;
uniform sampler2D uWallTex;
uniform float uHasWallTex;
uniform float uRange;        // HDR encode range, 1 for float targets
${COMMON}

// ---- Optics ---------------------------------------------------------------------------------

// Unpolarised reflectance. cosI is the angle in medium 1, eta = n1 / n2. 1 means total reflection.
float fresnel(float cosI, float eta) {
  float sin2t = eta * eta * (1.0 - cosI * cosI);
  if (sin2t >= 1.0) return 1.0;
  float cosT = sqrt(1.0 - sin2t);
  float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

// Rods wobble sideways as they rise: one wave per 0.36 world units of height.
const float WAVE_K = 17.45;

// Outward normal of a face at p. layer 0 is the outer shell's flutes, 1 the rods, anything else a
// smooth face. Each flute is a circular arc, so its normal turns linearly across its width, from
// -depth to +depth. "scale" fades the flutes out when they get too thin to resolve (near the edge
// of the drum). h is the height, which bends the rods.
vec2 faceNormal(vec2 p, int layer, float scale, float h) {
  vec2 radial = normalize(p);
  if (layer < 0) return radial;
  float theta = atan(p.x, p.y);
  float u = layer == 0 ? (theta - uPhi) * uFlutes / TAU : (theta - uRodPhi) * uRodN / TAU + uWave * 2.0 * sin(h * WAVE_K);
  float a = (layer == 0 ? uDepth : uRodDepth) * scale * (2.0 * fract(u) - 1.0);
  vec2 tangent = vec2(radial.y, -radial.x);
  return radial * cos(a) + tangent * sin(a);
}

// Moves a ray to the next circle and refracts it there. far takes the far side of the circle (a ray
// that leaves the inside). eta = n1 / n2. Returns false if the ray is lost (a miss, or total
// internal reflection). The path length is counted only while in glass.
bool hop(inout vec2 p, inout vec2 d, float radius, bool far, int layer, float h, float eta, bool fromGlass, inout float through, inout float glass) {
  float b = dot(p, d);
  float disc = b * b - (dot(p, p) - radius * radius);
  if (disc < 0.0) return false;
  float t = far ? -b + sqrt(disc) : -b - sqrt(disc);
  if (t < 0.0) return false;
  p += d * t;
  if (fromGlass) glass += t;
  vec2 n = faceNormal(p, layer, 1.0, h);
  if (dot(d, n) > 0.0) n = -n;
  through *= 1.0 - fresnel(max(-dot(n, d), 0.0), eta);
  vec2 r = refract(d, n, eta);
  if (dot(r, r) < 0.5) return false;
  d = r;
  return true;
}

// Softbox studio, as seen along a horizontal direction r = (x, z).
vec3 envColor(vec2 r) {
  r = normalize(r + vec2(1e-5));
  float az = atan(r.x, r.y);
  vec3 c = uWall * 0.14;
  c = mix(c, vec3(0.012), smoothstep(-0.2, 0.45, r.y));
  c += vec3(1.0, 0.95, 0.88) * 2.8 * exp(-pow((az - 0.62) / 0.15, 2.0));
  c += vec3(0.75, 0.85, 1.0) * 1.1 * exp(-pow((az + 0.95) / 0.28, 2.0));
  return c;
}

// ---- Sun --------------------------------------------------------------------------------------

const float SUN_BODY = 2.3;
const float SUN_HALO = 0.9;
// Light from the sun along a ray that passes it at closest approach (dperp across, dy up).
// rgb is emission and glow, a is how much of the disc covers the ray.
vec4 sunLight(float dperp, float dy) {
  float d = sqrt(dperp * dperp + dy * dy);
  float x = d / uSunR;
  float soft = 0.03 + 0.35 * uFrost;
  float inside = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, x);
  float mu = sqrt(max(1.0 - x * x, 0.0));
  vec3 surface = mix(uSunRim, uSunCore, smoothstep(0.1, 0.95, mu));
  float grain = 1.0 + 0.1 * (vnoise(vec2(dperp, dy) / uSunR * 5.0 + uTime * 0.2) - 0.5);
  // Limb darkening: the edge of a star is cooler and dimmer than its middle.
  vec3 body = surface * uSunPower * SUN_BODY * mix(0.3, 1.0, mu) * grain;

  float xf = sqrt(x * x + uFrost * uFrost * 0.8);
  float ang = atan(dy, dperp);
  float streak = 1.0 + uRays * 0.5 * (0.6 * sin(ang * 7.0 + uTime * 0.15) + 0.4 * sin(ang * 13.0 - uTime * 0.1)) * exp(-x * 0.25);
  float halo = (0.6 * exp(-xf * 1.5) + 0.25 / (1.0 + xf * xf * 0.6)) * (1.0 - smoothstep(4.0, 9.0, xf));
  return vec4(body * inside + uSunHalo * halo * streak * uSunPower * SUN_HALO, inside);
}

// ---- Wall -------------------------------------------------------------------------------------

vec3 wallAlbedo(vec2 p) {
  float silk = 0.86 + 0.14 * vnoise(vec2(p.x * 2.2, p.y * 0.7)) + 0.05 * (vnoise(vec2(p.x * 40.0, p.y * 1.6)) - 0.5);
  vec3 base = uWall * silk;
  if (uHasWallTex > 0.5) {
    vec2 tuv = vec2(p.x / (2.0 * uHalfView.x) + 0.5, (p.y - uCenterY) / (2.0 * uHalfView.y) + 0.5);
    base = pow(texture(uWallTex, clamp(tuv, 0.0, 1.0)).rgb, vec3(2.2));
  }
  return base;
}

// Wall colour at (x, y): albedo lit by a dim room plus the light thrown out of the glass. The
// caustic strip holds light per unit width along x. Height only spreads it, in a window that is the
// glass band blown up by the wall distance, softened by the size of the sun.
const float CAUSTIC_SCALE = 7.0;
vec3 wallRadiance(float x, float y) {
  float m = uWallDist;
  float edge = 0.12 * m + 0.8 * uSunR * (m - 1.0) + 0.04;
  float window = smoothstep(-edge, edge, GLASS_TOP * m - abs(y));
  float v = window / m / (1.0 + pow(y / (0.9 * m), 2.0));
  vec3 caustic = texture(uCaustic, vec2(x / (2.0 * uCausticRange) + 0.5, 0.5)).rgb;
  float bleed = exp(-(x * x + y * y) / (2.0 * 1.2 * 1.2));
  vec3 light = uBeam * (uCausticGain * CAUSTIC_SCALE * caustic * v + uWallGlow * bleed);
  // Silk has a sheen that reflects the light's own colour, so lit areas turn gold, not just brighter red.
  // A wall picture is meant to be seen, so it gets a brighter room than the plain silk.
  return wallAlbedo(vec2(x, y)) * (mix(0.16, 0.55, uHasWallTex) + light) + light * mix(0.16, 0.06, uHasWallTex);
}

// ---- Glass ------------------------------------------------------------------------------------

const float GLASS_HAZE = 0.2;

// One colour channel's ray through the drum, for the camera ray at (x, height). The path, front to
// back: outer face, outer shell's inner face, [rod outer face, rod inner face], the sun, then the
// same faces in reverse, and out to the wall.
vec3 trace(vec2 w, float ng) {
  float h = w.y;
  float z0 = sqrt(max(1.0 - w.x * w.x, 1e-5));
  vec2 p = vec2(w.x, z0);
  vec2 incident = vec2(0.0, -1.0);

  float flutePx = (TAU / uFlutes) * z0 / uPx;
  vec2 n0 = faceNormal(p, 0, smoothstep(1.2, 4.0, flutePx), h);
  float f0 = fresnel(max(-dot(n0, incident), 0.0), 1.0 / ng);
  // Gloss from the outer face. Only the rim of the drum reflects the sun's own glow.
  vec3 col = envColor(reflect(incident, n0)) * f0 * 1.6;
  // Where a ray cannot get through, the glass rim glows with light piped along the wall.
  vec3 rim = uWall * 0.45 + uBeam * uSunPower * 0.1;
  col += rim * pow(1.0 - z0, 1.5) * 0.6;
  float through = 1.0 - f0;
  float glass = 0.0;

  vec2 d = refract(incident, n0, 1.0 / ng);
  if (dot(d, d) < 0.5) return col;
  bool rods = uRods > 0.5;
  vec3 lost = col + rim * through;
  if (!hop(p, d, uRadii.x, false, -1, h, ng, true, through, glass)) return lost;
  if (rods) {
    if (!hop(p, d, uRadii.y, false, 1, h, 1.0 / ng, false, through, glass)) return lost;
    if (!hop(p, d, uRadii.z, false, -1, h, ng, true, through, glass)) return lost;
  }

  // Across the inside: the sun, if the ray passes near it.
  vec2 toSun = uSun.xz - p;
  float along = dot(toSun, d);
  float dperp = d.x * toSun.y - d.y * toSun.x;
  vec4 sun = sunLight(dperp, h - uSun.y) * smoothstep(-0.1, 0.1, along);
  vec3 seen = col + through * sun.rgb;

  if (rods) {
    if (!hop(p, d, uRadii.z, true, -1, h, 1.0 / ng, false, through, glass)) return seen;
    if (!hop(p, d, uRadii.y, true, 1, h, ng, true, through, glass)) return seen;
  }
  if (!hop(p, d, uRadii.x, true, -1, h, 1.0 / ng, false, through, glass)) return seen;
  if (!hop(p, d, 1.0, true, 0, h, ng, true, through, glass)) return seen;

  vec3 behind = envColor(d) * 0.4;
  if (d.y < -0.02) behind = wallRadiance(p.x + d.x * ((-uWallDist - p.y) / d.y), h);
  // The glass bodies scatter a little of the sun's light, so no part of the band goes dead dark.
  vec3 haze = uBeam * uSunPower * GLASS_HAZE;
  return col + through * exp(-uAbsorb * glass) * (sun.rgb + (1.0 - sun.a) * behind + haze);
}

vec3 glassPixel(vec2 w) {
  if (uSpectral < 0.5) return trace(w, uIor.g);
  return vec3(trace(w, uIor.r).r, trace(w, uIor.g).g, trace(w, uIor.b).b);
}

// ---- Lacquer and metal ------------------------------------------------------------------------

// Radius of the cap profile at height y, 0 where there is none. mat: 1 lacquer, 2 metal.
// ny is the vertical slope of the surface (for the rounded edges).
float capProfile(float y, out float mat, out float ny) {
  mat = 0.0;
  ny = 0.0;
  if (y >= -0.67 && y < -0.48) {
    mat = 1.0;
    float c = -0.62;
    float e = c - y;
    if (e > 0.0) {
      ny = -clamp(e / 0.05, 0.0, 0.999);
      return 0.85 + sqrt(max(0.0025 - e * e, 0.0));
    }
    return 0.9;
  }
  if (y >= -0.48 && y < GLASS_BOTTOM) { mat = 2.0; return 1.012; }
  if (y >= GLASS_TOP && y < 0.48) { mat = 2.0; return 1.012; }
  if (y >= 0.48 && y < 0.9) { mat = 1.0; return 1.0; }
  if (y >= 0.9 && y < 0.925) { mat = 2.0; return 0.94; }
  if (y >= 0.925 && y < 1.17) {
    mat = 1.0;
    float e = y - 1.11;
    if (e > 0.0) {
      ny = clamp(e / 0.06, 0.0, 0.999);
      return 0.83 + sqrt(max(0.0036 - e * e, 0.0));
    }
    return 0.89;
  }
  return 0.0;
}

// Signed distance to the handle's outline (a rounded rectangle). Legs run into the lid.
float handleSd(vec2 p) {
  vec2 q = abs(p - vec2(0.0, 1.215)) - (vec2(0.5, 0.09) - 0.05);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.05;
}

// Light that leaks over the caps next to the glass.
vec3 spill(float y) {
  float dist = y > 0.0 ? y - GLASS_TOP : GLASS_BOTTOM - y;
  return uBeam * uSunPower * 0.3 * exp(-max(dist, 0.0) / 0.16);
}

vec3 surfaceShade(vec3 n, float y, float mat) {
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 keyDir = normalize(vec3(0.5, 0.55, 0.65));
  float diffuse = max(dot(n, keyDir), 0.0);
  vec3 r = reflect(-view, n);
  vec3 env = envColor(r.xz);
  float cosV = max(dot(n, view), 0.0);
  float schlick = pow(1.0 - cosV, 5.0);
  vec3 glow = spill(y);
  if (mat > 1.5) {
    vec3 m = uMetal;
    return m * (0.12 + 0.35 * diffuse) + m * env * 1.2 + m * glow * 1.4;
  }
  float f = 0.05 + 0.95 * schlick;
  float spec = pow(max(dot(n, normalize(keyDir + view)), 0.0), 80.0);
  return uLacquer * (0.1 + 0.9 * diffuse) + env * f * 1.4 + vec3(spec) * 0.8 + uLacquer * glow * 0.9;
}

// ---- Gold line art ----------------------------------------------------------------------------
// Every motif is a distance (in world units) to its nearest line, so one routine can draw it, bevel
// it and antialias it. Patterns are laid out by azimuth, so they wrap the drum and foreshorten.

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// Key fret (lei wen): a baseline with a square spiral rising from it. q is the cell, 0 to 1.
float keyFret(vec2 q) {
  float d = segDist(q, vec2(0.0, 0.12), vec2(1.0, 0.12));
  d = min(d, segDist(q, vec2(0.88, 0.12), vec2(0.88, 0.88)));
  d = min(d, segDist(q, vec2(0.88, 0.88), vec2(0.3, 0.88)));
  d = min(d, segDist(q, vec2(0.3, 0.88), vec2(0.3, 0.36)));
  d = min(d, segDist(q, vec2(0.3, 0.36), vec2(0.62, 0.36)));
  return min(d, segDist(q, vec2(0.62, 0.36), vec2(0.62, 0.62)));
}

// Lotus medallion: two rings, an eight-petal flower, a small ring and a bud.
float lotus(vec2 l, float radius) {
  float r = length(l);
  float a = atan(l.y, l.x);
  float petal = abs(r - radius * 0.74 * (0.3 + 0.7 * abs(cos(4.0 * a)))) * 0.75;
  float d = min(abs(r - radius), abs(r - radius * 0.88));
  d = min(d, petal);
  d = min(d, abs(r - radius * 0.2));
  return min(d, max(r - radius * 0.07, 0.0));
}

// Ancient coin: a ring with a square hole.
float coin(vec2 l, float radius) {
  return min(abs(length(l) - radius), abs(max(abs(l.x), abs(l.y)) - radius * 0.38));
}

// A pair of mirrored scrolls on a ground line: the cloud scroll (xiangyun).
float scroll(vec2 l, float radius) {
  vec2 q = vec2(abs(l.x) - radius * 0.56, l.y);
  float r = length(q);
  float pitch = radius * 0.2;
  float turn = atan(q.y, q.x) / TAU * (l.x < 0.0 ? -1.0 : 1.0);
  float d = abs(fract(r / pitch - turn + 0.5) - 0.5) * pitch + max(r - radius * 0.5, 0.0);
  return min(d, segDist(l, vec2(-radius, -radius * 0.55), vec2(radius, -radius * 0.55)));
}

// Distance to the nearest gold line at azimuth az, height y, on a surface of radius r. 1.0 = none.
float ornDist(float az, float y, float r) {
  float d = 1.0;
  if (y >= 0.48 && y < 0.9) {
    // Band: key fret above and below, lotus medallions and coins between.
    d = min(min(abs(y - 0.5835), abs(y - 0.8065)), min(abs(y - 0.4975), abs(y - 0.8925)));
    float cw = TAU * r / 78.0;
    float u = az * 78.0 / TAU + 0.5;
    if (y < 0.4975 + cw) d = min(d, keyFret(vec2(fract(u), (y - 0.4975) / cw)) * cw);
    if (y > 0.8925 - cw) d = min(d, keyFret(vec2(fract(u), (0.8925 - y) / cw)) * cw);
    if (y > 0.5835 && y < 0.8065) {
      float cell = TAU * r / 20.0;
      float uc = az * 20.0 / TAU + 0.5;
      d = min(d, lotus(vec2((fract(uc) - 0.5) * cell, y - 0.695), 0.108));
      d = min(d, coin(vec2((fract(uc + 0.5) - 0.5) * cell, y - 0.695), 0.036));
    }
  } else if (y >= 0.925 && y < 1.17) {
    // Lid: a row of cloud scrolls between fine lines.
    d = min(min(abs(y - 0.95), abs(y - 1.092)), abs(y - 1.135));
    if (y > 0.97 && y < 1.075) {
      float cell = TAU * r / 24.0;
      float uc = az * 24.0 / TAU + 0.5;
      d = min(d, scroll(vec2((fract(uc) - 0.5) * cell, y - 1.0225), cell * 0.5));
    }
  } else if (y >= -0.67 && y < -0.48) {
    // Foot: one key fret band.
    float cw = TAU * r / 70.0;
    d = abs(y + 0.505);
    if (y > -0.62 && y < -0.62 + cw) d = min(d, keyFret(vec2(fract(az * 70.0 / TAU + 0.5), (y + 0.62) / cw)) * cw);
  }
  return d;
}

// A faint diamond diaper woven into the lacquer behind the medallions and scrolls.
float groundDiaper(float az, float y, float r) {
  if (!((y > 0.5835 && y < 0.8065) || (y > 0.97 && y < 1.075))) return 0.0;
  float s = az * r;
  float l = min(abs(fract((s + y) / 0.06) - 0.5), abs(fract((s - y) / 0.06) - 0.5));
  return 1.0 - smoothstep(0.04, 0.12, l);
}

vec3 capShade(vec2 w, float r, float mat, float ny) {
  float sx = clamp(w.x / r, -1.0, 1.0);
  float az = asin(sx);
  float hz = sqrt(max(1.0 - ny * ny, 0.0));
  vec3 n = vec3(sx * hz, ny, sqrt(max(1.0 - sx * sx, 0.0)) * hz);

  if (mat > 1.5) {
    // Metal collars carry a row of beads.
    if (r > 1.005) {
      float cell = TAU * r / 130.0;
      float yc = w.y > 0.0 ? 0.465 : -0.465;
      vec2 l = vec2((fract(az * 130.0 / TAU) - 0.5) * cell, w.y - yc);
      float q = length(l) / 0.0146;
      n.xy += l / 0.0146 * 0.75 * step(q, 1.0) * uOrnament;
      return surfaceShade(normalize(n), w.y, mat) * mix(1.0, mix(0.35, 1.0, 1.0 - smoothstep(0.85, 1.15, q)), uOrnament);
    }
    return surfaceShade(n, w.y, mat);
  }

  // Lacquer: a faint orange-peel texture, a diamond diaper, and gold line art on top.
  vec2 tx = vec2(az * r * 160.0, w.y * 160.0);
  n.xy += (vec2(vnoise(tx), vnoise(tx + 17.3)) - 0.5) * 0.035;
  n = normalize(n);
  float tone = 1.0 - 0.14 * groundDiaper(az, w.y, r) * uOrnament;
  vec3 lacquer = surfaceShade(n, w.y, 1.0) * tone;
  if (uOrnament < 0.01) return lacquer;

  float aa = uPx * 0.8;
  float hw = max(0.0042, uPx * 1.1);
  float d0 = ornDist(az, w.y, r);
  if (d0 > hw + 0.02) return lacquer;
  float e = 0.0035;
  float span = hw * 1.7;
  float h0 = 1.0 - smoothstep(0.0, span, d0);
  float hx = 1.0 - smoothstep(0.0, span, ornDist(az + e / r, w.y, r));
  float hy = 1.0 - smoothstep(0.0, span, ornDist(az, w.y + e, r));
  // The line is raised, with a rounded profile; the lacquer beside it sits in a thin shadow.
  vec3 gold = surfaceShade(normalize(n - vec3(hx - h0, hy - h0, 0.0) * 1.4), w.y, 2.0);
  lacquer *= 1.0 - 0.3 * exp(-max(d0 - hw, 0.0) / 0.008);
  float m = (1.0 - smoothstep(hw - aa, hw + aa, d0)) * uOrnament;
  return mix(lacquer, gold, m);
}

vec3 shade(vec2 w) {
  float ax = abs(w.x);
  if (w.y > GLASS_BOTTOM && w.y < GLASS_TOP && ax < 1.0) return glassPixel(w);

  float mat;
  float ny;
  float r = capProfile(w.y, mat, ny);
  if (r > 0.0 && ax < r) return capShade(w, r, mat, ny);

  if (w.y > 1.17) {
    float sd = handleSd(w);
    if (sd < 0.0 && sd > -0.04) {
      float t = (sd + 0.02) / 0.02;
      vec2 e = vec2(0.002, 0.0);
      vec2 grad = normalize(vec2(handleSd(w + e.xy) - handleSd(w - e.xy), handleSd(w + e.yx) - handleSd(w - e.yx)) + 1e-6);
      vec3 n = normalize(vec3(grad * t * 0.9, 1.0));
      return surfaceShade(n, w.y, 2.0);
    }
  }
  return wallRadiance(w.x, w.y);
}

void main() {
  vec2 w = vec2((vUv.x * 2.0 - 1.0) * uHalfView.x, uCenterY + (vUv.y * 2.0 - 1.0) * uHalfView.y);
  vec3 col;
  // The wall is smooth, so only pixels near the lantern need the four-sample antialiasing.
  if (abs(w.x) > 1.15 || w.y < -0.75 || w.y > 1.45) {
    col = shade(w);
  } else {
    col = shade(w + vec2(-0.125, -0.375) * uPx);
    col += shade(w + vec2(0.375, -0.125) * uPx);
    col += shade(w + vec2(0.125, 0.375) * uPx);
    col += shade(w + vec2(-0.375, 0.125) * uPx);
    col *= 0.25;
  }
  outColor = vec4(hdrEncode(col, uRange), 1.0);
}
`;

export const LANTERN_BLUR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uDir;           // one texel of the target, along the blur axis
uniform float uExtract;      // 1 on the first pass: keep only the bright parts
uniform float uRange;
${COMMON}

vec3 fetch(vec2 uv) {
  vec3 c = hdrDecode(texture(uTex, uv).rgb, uRange);
  if (uExtract > 0.5) {
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(0.7, 2.0, l);
  }
  return c;
}

void main() {
  vec3 c = fetch(vUv) * 0.2270270270;
  c += (fetch(vUv + uDir * 1.3846153846) + fetch(vUv - uDir * 1.3846153846)) * 0.3162162162;
  c += (fetch(vUv + uDir * 3.2307692308) + fetch(vUv - uDir * 3.2307692308)) * 0.0702702703;
  outColor = vec4(hdrEncode(c, uRange), 1.0);
}
`;

export const LANTERN_COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform sampler2D uB3;
uniform sampler2D uB4;
uniform sampler2D uB5;
uniform float uBloom;
uniform float uExposure;
uniform float uGrain;
uniform float uTime;
uniform float uRange;
${COMMON}

// Narkowicz's fit of the ACES filmic curve: soft toe, bright shoulder.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 col = hdrDecode(texture(uScene, vUv).rgb, uRange);
  vec3 bloom = hdrDecode(texture(uB1, vUv).rgb, uRange) * 0.14 + hdrDecode(texture(uB2, vUv).rgb, uRange) * 0.2
    + hdrDecode(texture(uB3, vUv).rgb, uRange) * 0.26 + hdrDecode(texture(uB4, vUv).rgb, uRange) * 0.3
    + hdrDecode(texture(uB5, vUv).rgb, uRange) * 0.34;
  col += bloom * uBloom;
  vec2 c = vUv * 2.0 - 1.0;
  col *= 1.0 - 0.38 * smoothstep(0.45, 1.5, length(c * vec2(0.8, 1.0)));
  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  // Triangular dither hides banding in the dark gradients. Grain adds a film-like grit.
  float tq = floor(uTime * 24.0);
  float n = hash12(gl_FragCoord.xy + tq * 13.7) + hash12(gl_FragCoord.yx * 1.3 + tq * 5.1) - 1.0;
  col += n * (1.0 / 255.0 + uGrain * 0.03);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
