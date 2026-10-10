/**
 * Foil shading, ported from bubbbly.com/foil-studio and flattened to a 2D page.
 *
 * Their scene is Three.js: a card mesh, a perspective camera at z=6, and a ShaderMaterial. Here the
 * "card" is the element itself, lying in the screen plane, and every distance is in CSS px. The look
 * comes from three light sources:
 *
 *  1. studio(): a fake environment (softbox top-left, strip right, bounce card low). The foil is a
 *     mirror, so a pixel is bright only where its bent normal reflects the view ray into one of
 *     those boxes. The pointer nudges the boxes slightly, so the whole sheet shimmers as you move.
 *  2. the lamp: a point light hovering above the cursor. Blinn-Phong with exponents 220 ("hot",
 *     the white-hot flash) and 28 ("glow", the soft halo). This is the torch you steer.
 *  3. a dim key light for the matte paper so non-foil parts still read as lit.
 *
 * Normals come from the height map (fx.b) by central differences, plus value noise for the foil's
 * crinkle and the paper's tooth. uTilt rotates the surface when the element is dragged.
 */

export const FOIL_VERTEX = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FOIL_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uMap;   // print: paper + inked foil, straight alpha
uniform sampler2D uFx;    // r foil, g pearl, b height
uniform vec2 uFxTexel;    // 1 / map size
uniform vec2 uAspect;     // map size / longest side, for isotropic noise
uniform vec4 uRect;       // element left, top, width, height in viewport CSS px
uniform vec2 uViewport;   // viewport width, height in CSS px
uniform float uCamZ;      // camera distance from the page, CSS px
uniform vec3 uLamp;       // lamp position, page space (origin at viewport centre, y up), CSS px
uniform float uLampOn;
uniform vec2 uLight;      // pointer nudge of the studio, radians
uniform vec2 uTilt;       // surface rotation about x and y, radians
uniform vec3 uTint;       // colour of the foil's flash
uniform float uRelief;
uniform float uCrinkle;
uniform float uShine;
uniform float uGrain;
varying vec2 vUv;

float box(vec2 a, vec2 c, vec2 hs, float soft) {
  vec2 d = abs(a - c) - hs;
  return 1.0 - smoothstep(-soft, soft, max(d.x, d.y));
}
// a softbox up and to the left, a strip light right, a bounce card low
float studio(vec3 r) {
  vec2 a = vec2(atan(r.x, r.z), asin(clamp(r.y, -1.0, 1.0))) - uLight;
  float e = 0.25;
  vec2 k = (a - vec2(-0.34, 0.27)) / vec2(0.26, 0.15);
  e += 2.4 * box(a, vec2(-0.34, 0.27), vec2(0.26, 0.15), 0.12) * (1.0 - 0.45 * dot(k, k));
  e += 1.9 * box(a, vec2(0.4, -0.02), vec2(0.045, 0.55), 0.06);
  e += 0.7 * box(a, vec2(0.0, -0.5), vec2(0.9, 0.06), 0.18);
  return e;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 spectrum(float x) {
  return 0.5 + 0.5 * cos(6.2831853 * (x + vec3(0.0, 0.33, 0.67)));
}

void main() {
  // Texture v runs top-down (canvas), quad v runs bottom-up.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 print = texture2D(uMap, uv);
  if (print.a < 0.002) discard;
  vec3 base = print.rgb;
  vec3 fx = texture2D(uFx, uv).rgb;
  float foil = fx.r;
  float pearl = fx.g;

  // This fragment in page space: origin at viewport centre, y up, z = 0 on the page.
  vec2 css = uRect.xy + uv * uRect.zw;
  vec3 P = vec3(css.x - 0.5 * uViewport.x, 0.5 * uViewport.y - css.y, 0.0);
  vec3 V = normalize(vec3(0.0, 0.0, uCamZ) - P);
  // Tilted surface frame (rotate about y, then x).
  float cy = cos(uTilt.y), sy = sin(uTilt.y), cx = cos(uTilt.x), sx = sin(uTilt.x);
  vec3 T = vec3(cy, 0.0, -sy);
  vec3 B = vec3(sy * sx, cx, cy * sx);
  vec3 N = vec3(sy * cx, -sx, cy * cx);
  vec3 L = normalize(vec3(-0.45 + uLight.x, 0.55 + uLight.y, 0.7));

  // the stamp's relief, the paper's tooth, and the foil's own fine crinkle
  float hx = texture2D(uFx, uv + vec2(uFxTexel.x, 0.0)).b - texture2D(uFx, uv - vec2(uFxTexel.x, 0.0)).b;
  float hy = texture2D(uFx, uv - vec2(0.0, uFxTexel.y)).b - texture2D(uFx, uv + vec2(0.0, uFxTexel.y)).b;
  vec2 q = uv * uAspect;
  vec2 tooth = vec2(noise(q * vec2(420.0, 160.0)), noise(q * vec2(160.0, 420.0) + 7.3)) - 0.5;
  vec2 crinkle = vec2(noise(q * 180.0), noise(q * 180.0 + 11.1)) - 0.5;
  vec2 bump = vec2(hx, hy) * uRelief + tooth * 0.08 * uGrain * (1.0 - foil) + crinkle * uCrinkle * foil;
  vec3 Nb = normalize(N - T * bump.x - B * bump.y);
  base *= 1.0 + uGrain * 0.06 * (noise(q * vec2(700.0, 260.0)) - 0.5);

  float ndl = max(dot(Nb, L), 0.0);
  float caught = smoothstep(0.35, 2.4, studio(reflect(-V, Nb)));
  vec3 Lp = normalize(uLamp - P);
  float nh = max(dot(Nb, normalize(Lp + V)), 0.0);
  float hot = pow(nh, 220.0) * uLampOn * uShine;
  float glow = pow(nh, 28.0) * uLampOn;

  // matte paper under a soft key, with a breath of sheen where the lamp is
  vec3 paper = base * (0.8 + 0.26 * ndl) + glow * 0.03;
  // The foil is a mirror: dim where it reflects nothing, up where it catches the studio,
  // white-hot in its own colour where it looks straight back at the lamp.
  vec3 metal = base * (mix(0.42, 1.0, caught) + glow * 0.95) + uTint * (0.6 * pow(caught, 3.0) + hot * 2.4);
  // pearl ink: a satin sheen with a faint shift of colour as it turns
  float phase = dot(Nb.xy, vec2(1.7, 1.1)) * 1.4 + dot(V.xy, vec2(0.9, -0.6)) + uv.y * 0.8;
  vec3 satin = mix(vec3(1.0), spectrum(phase), 0.35) * (hot * 0.7 + glow * 0.22 + 0.12 * caught);

  vec3 col = min(mix(paper, metal, foil) + satin * pearl, vec3(1.0));
  gl_FragColor = vec4(col * print.a, print.a); // premultiplied for the page compositor
}
`;
