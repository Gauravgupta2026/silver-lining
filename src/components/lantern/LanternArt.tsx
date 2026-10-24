"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadImage } from "@/components/imageCache";
import { computeCaustic, GLASS_RADIUS, shellRadii } from "./lanternPhysics";
import { FRAMES, LANTERN_LOOKS, resolveLanternSettings, type LanternSettings, type LanternSettingsInput, type RGB } from "./lanternSettings";
import { LANTERN_BLUR_FRAGMENT, LANTERN_COMPOSITE_FRAGMENT, LANTERN_SCENE_FRAGMENT, LANTERN_VERTEX, LAYOUT } from "./lanternShader";

export type { LanternSettingsInput };

/** Imperative handle for tools such as the studio. */
export interface LanternHandle {
  /** PNG of the current frame, as a data URL. */
  snapshot(): string;
  /** The live canvas, for video capture. */
  canvas(): HTMLCanvasElement;
}

interface LanternArtProps {
  settings?: LanternSettingsInput;
  /** A picture for the wall behind the lantern. It is lit by the sun and seen through the glass. */
  backdropSrc?: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  onReady?: (handle: LanternHandle) => void;
  onError?: (error: Error) => void;
}

/** Bins in the strip of light thrown on the wall. */
const CAUSTIC_BINS = 2048;
/** Bloom pyramid: each level is this many times smaller than the picture. */
const BLOOM_DIVISORS = [2, 4, 8, 16, 32] as const;
const MAX_DPR = 2;
/** Backing store never exceeds this many device pixels, so large screens stay smooth. */
const MAX_CANVAS_PIXELS = 3_000_000;
/** Max frame delta, so a backgrounded tab does not jump on return. */
const MAX_DT = 0.05;
/** Range that 8-bit targets stand for, when the GPU cannot render to float textures. */
const FALLBACK_HDR_RANGE = 8;
/** How fast the ring speed, the sun orbit and the sun's turn ease toward their targets, per second. */
const EASE_RATE = 3;
/** After a drag, the spin eases away at this rate per second. */
const SPIN_DECAY_RATE = 1.8;
const MAX_SPIN = 12;
/** The sun never touches the glass: this much clearance is kept between them. */
const SUN_CLEARANCE = 0.04;
/** The caustic emitter is this share of the sun's radius. Smaller is sharper. */
const EMITTER_SHARE = 0.25;
/** Light absorbed by the glass, in the shader's units per world unit. */
const ABSORB_SCALE = 6;
const START_PHI = 0.37;
const START_ROD_PHI = 1.1;
const START_SUN_ANGLE = 2.4;
const RPM_TO_RAD_PER_SECOND = (Math.PI * 2) / 60;

const toLinear = (rgb: RGB): [number, number, number] => [Math.pow(rgb[0] / 255, 2.2), Math.pow(rgb[1] / 255, 2.2), Math.pow(rgb[2] / 255, 2.2)];

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  u: Uniforms;
}

interface GLState {
  scene: Program;
  blur: Program;
  composite: Program;
  causticTex: WebGLTexture;
  wallTex: WebGLTexture;
  buffer: WebGLBuffer;
  hdr: boolean;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string, names: readonly string[]): Program {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, LANTERN_VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  return { program, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) };
}

const SCENE_UNIFORMS = [
  "uRes", "uHalfView", "uCenterY", "uPx", "uPhi", "uFlutes", "uDepth", "uIor", "uSpectral", "uRods", "uRodN", "uRodDepth", "uRodPhi", "uWave", "uRadii", "uOrnament", "uAbsorb", "uFrost", "uSun", "uSunR", "uSunPower",
  "uSunCore", "uSunRim", "uSunHalo", "uBeam", "uRays", "uTime", "uWallDist", "uCaustic", "uCausticRange", "uCausticGain", "uWallGlow", "uWall",
  "uLacquer", "uMetal", "uWallTex", "uHasWallTex", "uRange",
] as const;
const BLUR_UNIFORMS = ["uTex", "uDir", "uExtract", "uRange"] as const;
const COMPOSITE_UNIFORMS = ["uScene", "uB1", "uB2", "uB3", "uB4", "uB5", "uBloom", "uExposure", "uGrain", "uTime", "uRange"] as const;

function makeTexture(gl: WebGL2RenderingContext) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function initGL(gl: WebGL2RenderingContext): GLState {
  // Float colour targets keep the sun's real brightness, so its bloom is wide and soft.
  const hdr = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  const scene = link(gl, LANTERN_SCENE_FRAGMENT, SCENE_UNIFORMS);
  const blur = link(gl, LANTERN_BLUR_FRAGMENT, BLUR_UNIFORMS);
  const composite = link(gl, LANTERN_COMPOSITE_FRAGMENT, COMPOSITE_UNIFORMS);

  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  const causticTex = makeTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, causticTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, CAUSTIC_BINS, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(CAUSTIC_BINS * 4));

  const wallTex = makeTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, wallTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return { scene, blur, composite, causticTex, wallTex, buffer, hdr };
}

function makeTarget(gl: WebGL2RenderingContext, w: number, h: number, hdr: boolean): Target {
  const tex = makeTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Render target is not supported");
  return { tex, fbo, w, h };
}

function freeTarget(gl: WebGL2RenderingContext, t: Target) {
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

function bindTexture(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

/** The picture, then two targets per bloom level (horizontal, then vertical pass). */
interface Targets {
  scene: Target;
  bloom: { a: Target; b: Target }[];
}

function makeTargets(gl: WebGL2RenderingContext, w: number, h: number, hdr: boolean): Targets {
  const scene = makeTarget(gl, w, h, hdr);
  const bloom = BLOOM_DIVISORS.map((d) => {
    const bw = Math.max(2, Math.round(w / d));
    const bh = Math.max(2, Math.round(h / d));
    return { a: makeTarget(gl, bw, bh, hdr), b: makeTarget(gl, bw, bh, hdr) };
  });
  return { scene, bloom };
}

function freeTargets(gl: WebGL2RenderingContext, t: Targets) {
  freeTarget(gl, t.scene);
  t.bloom.forEach(({ a, b }) => {
    freeTarget(gl, a);
    freeTarget(gl, b);
  });
}

const ease = (dt: number) => 1 - Math.exp(-dt * EASE_RATE);

/**
 * A sun inside a drum of fluted glass, drawn live: real refraction through the flutes, colour
 * fringes, light thrown on the wall, and bloom. Needs WebGL2; without it a still glow is shown.
 */
export function LanternArt({ settings, backdropSrc, alt = "A glowing sun inside a fluted glass lantern", className, style, onReady, onError }: LanternArtProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  const resolved = resolveLanternSettings(settings);
  const aspect = FRAMES[resolved.frame].aspect;

  // Values read inside the long-lived effect; synced after every render.
  const live = useRef({ settings: resolved, onReady, onError });
  const dirty = useRef<(() => void) | null>(null);
  useEffect(() => {
    live.current = { settings: resolved, onReady, onError };
    dirty.current?.();
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) {
      setFailed(true);
      live.current.onError?.(new Error("WebGL is not available"));
      return;
    }

    let disposed = false;
    let raf = 0;
    let visible = false;
    let state: GLState | null = null;
    let targets: Targets | null = null;
    let hasWallTex = false;
    let clock = 0;
    let last = performance.now();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Motion state. Rates ease toward their targets, so changing a setting never jerks the picture.
    const motion = { phi: START_PHI, rodPhi: START_ROD_PHI, sunAngle: START_SUN_ANGLE, glassRate: 0, sunRate: 0, orbit: 0, spin: 0 };
    const caustic = new Float32Array(CAUSTIC_BINS * 4);

    const fail = (err: unknown) => {
      if (disposed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("LanternArt:", error);
      setFailed(true);
      live.current.onError?.(error);
    };

    const drawQuad = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const setTarget = (t: Target | null, w: number, h: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, w, h);
    };

    const advance = (s: LanternSettings, dt: number) => {
      const turnsGlass = s.turns !== "sun";
      const turnsSun = s.turns !== "glass";
      const live_ = reduceMotion ? 0 : 1;
      const glassTarget = turnsGlass ? s.glassSpeed * RPM_TO_RAD_PER_SECOND * live_ : 0;
      const sunTarget = turnsSun ? s.sunSpeed * RPM_TO_RAD_PER_SECOND * live_ : 0;
      const orbitTarget = turnsSun ? s.sunOrbit : 0;
      const k = ease(dt);
      motion.glassRate += (glassTarget - motion.glassRate) * k;
      motion.sunRate += (sunTarget - motion.sunRate) * k;
      motion.orbit += (orbitTarget - motion.orbit) * k;
      motion.spin *= Math.exp(-dt * SPIN_DECAY_RATE);
      const turn = (motion.glassRate + motion.spin) * dt;
      motion.phi += turn;
      motion.rodPhi += turn * s.rodSpin;
      motion.sunAngle += motion.sunRate * dt;
    };

    const draw = (dt: number) => {
      if (!state) return;
      const s = live.current.settings;
      clock += dt;
      advance(s, dt);

      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, rect.width * dpr * rect.height * dpr)));
      const bw = Math.max(2, Math.round(rect.width * dpr * fit));
      const bh = Math.max(2, Math.round(rect.height * dpr * fit));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      if (!targets || targets.scene.w !== bw || targets.scene.h !== bh) {
        if (targets) freeTargets(gl, targets);
        targets = makeTargets(gl, bw, bh, state.hdr);
      }

      const look = LANTERN_LOOKS[s.look];
      const frameAspect = FRAMES[s.frame].aspect;
      const halfView: [number, number] = [(LAYOUT.viewHeight * frameAspect) / 2, LAYOUT.viewHeight / 2];
      const rods = s.rodLayer === "on";
      const shells = shellRadii(s.thickness, rods);
      const sunRadius = s.sunSize * GLASS_RADIUS;
      const orbit = Math.max(0, Math.min(motion.orbit * GLASS_RADIUS, shells.clear - sunRadius - SUN_CLEARANCE));
      const sunX = orbit * Math.sin(motion.sunAngle);
      const sunZ = orbit * Math.cos(motion.sunAngle);
      const flickerWave = Math.sin(clock * 1.7) * 0.06 + Math.sin(clock * 4.3 + 1) * 0.04 + Math.sin(clock * 11.3 + 2) * 0.02;
      const sunPower = s.sunBrightness * (1 + (reduceMotion ? 0 : s.flicker * flickerWave * 2));
      const ior: [number, number, number] = [s.glassIndex - s.dispersion, s.glassIndex, s.glassIndex + s.dispersion];
      const halfRange = halfView[0] * 1.2 + 0.3;
      const depth = (s.depth * Math.PI) / 180;
      const rodDepth = (s.rodDepth * Math.PI) / 180;

      computeCaustic(caustic, CAUSTIC_BINS, {
        phi: motion.phi,
        rodPhi: motion.rodPhi,
        sunX,
        sunZ,
        emitterRadius: sunRadius * EMITTER_SHARE,
        flutes: s.flutes,
        rodFlutes: s.rods,
        depth,
        rodDepth,
        ior,
        shells,
        wallDistance: s.wallDistance,
        halfRange,
      });
      bindTexture(gl, 0, state.causticTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CAUSTIC_BINS, 1, gl.RGBA, gl.FLOAT, caustic);

      const range = state.hdr ? 1 : FALLBACK_HDR_RANGE;
      const { scene, blur, composite } = state;
      const t = targets;

      gl.useProgram(scene.program);
      bindTexture(gl, 0, state.causticTex);
      bindTexture(gl, 1, state.wallTex);
      gl.uniform1i(scene.u.uCaustic, 0);
      gl.uniform1i(scene.u.uWallTex, 1);
      gl.uniform1f(scene.u.uHasWallTex, hasWallTex ? 1 : 0);
      gl.uniform2f(scene.u.uRes, bw, bh);
      gl.uniform2f(scene.u.uHalfView, halfView[0], halfView[1]);
      gl.uniform1f(scene.u.uCenterY, LAYOUT.centerY);
      gl.uniform1f(scene.u.uPx, LAYOUT.viewHeight / bh);
      gl.uniform1f(scene.u.uPhi, motion.phi);
      gl.uniform1f(scene.u.uFlutes, s.flutes);
      gl.uniform1f(scene.u.uDepth, depth);
      gl.uniform3f(scene.u.uIor, ior[0], ior[1], ior[2]);
      gl.uniform1f(scene.u.uSpectral, s.dispersion > 0.0005 ? 1 : 0);
      gl.uniform1f(scene.u.uRods, rods ? 1 : 0);
      gl.uniform1f(scene.u.uRodN, s.rods);
      gl.uniform1f(scene.u.uRodDepth, rodDepth);
      gl.uniform1f(scene.u.uRodPhi, motion.rodPhi);
      gl.uniform1f(scene.u.uWave, s.wave);
      gl.uniform3f(scene.u.uRadii, shells.outerInner, shells.rodOuter, shells.rodInner);
      gl.uniform1f(scene.u.uOrnament, s.ornament);
      gl.uniform3f(scene.u.uAbsorb, ...(look.glass.map((v) => (v / 255) * ABSORB_SCALE) as [number, number, number]));
      gl.uniform1f(scene.u.uFrost, s.frost);
      gl.uniform3f(scene.u.uSun, sunX, 0, sunZ);
      gl.uniform1f(scene.u.uSunR, sunRadius);
      gl.uniform1f(scene.u.uSunPower, sunPower);
      gl.uniform3f(scene.u.uSunCore, ...toLinear(look.core));
      gl.uniform3f(scene.u.uSunRim, ...toLinear(look.rim));
      gl.uniform3f(scene.u.uSunHalo, ...toLinear(look.halo));
      gl.uniform3f(scene.u.uBeam, ...toLinear(look.beam));
      gl.uniform1f(scene.u.uRays, s.rays);
      gl.uniform1f(scene.u.uTime, clock);
      gl.uniform1f(scene.u.uWallDist, s.wallDistance);
      gl.uniform1f(scene.u.uCausticRange, halfRange);
      gl.uniform1f(scene.u.uCausticGain, s.caustics * sunPower);
      gl.uniform1f(scene.u.uWallGlow, 0.3 * sunPower);
      gl.uniform3f(scene.u.uWall, ...toLinear(look.wall));
      gl.uniform3f(scene.u.uLacquer, ...toLinear(look.lacquer));
      gl.uniform3f(scene.u.uMetal, ...toLinear(look.metal));
      gl.uniform1f(scene.u.uRange, range);
      setTarget(t.scene, bw, bh);
      drawQuad();

      gl.useProgram(blur.program);
      gl.uniform1i(blur.u.uTex, 0);
      gl.uniform1f(blur.u.uRange, range);
      let from: Target = t.scene;
      t.bloom.forEach(({ a, b }, level) => {
        gl.uniform1f(blur.u.uExtract, level === 0 ? 1 : 0);
        bindTexture(gl, 0, from.tex);
        gl.uniform2f(blur.u.uDir, 1 / a.w, 0);
        setTarget(a, a.w, a.h);
        drawQuad();
        gl.uniform1f(blur.u.uExtract, 0);
        bindTexture(gl, 0, a.tex);
        gl.uniform2f(blur.u.uDir, 0, 1 / b.h);
        setTarget(b, b.w, b.h);
        drawQuad();
        from = b;
      });

      gl.useProgram(composite.program);
      bindTexture(gl, 0, t.scene.tex);
      t.bloom.forEach(({ b }, i) => bindTexture(gl, i + 1, b.tex));
      gl.uniform1i(composite.u.uScene, 0);
      (["uB1", "uB2", "uB3", "uB4", "uB5"] as const).forEach((name, i) => gl.uniform1i(composite.u[name], i + 1));
      gl.uniform1f(composite.u.uBloom, s.bloom);
      gl.uniform1f(composite.u.uExposure, s.exposure);
      gl.uniform1f(composite.u.uGrain, s.grain);
      gl.uniform1f(composite.u.uTime, reduceMotion ? 0 : clock);
      gl.uniform1f(composite.u.uRange, range);
      setTarget(null, bw, bh);
      drawQuad();
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed || !visible || gl.isContextLost()) return;
      const dt = Math.min(MAX_DT, (now - last) / 1000);
      last = now;
      try {
        draw(dt);
      } catch (err) {
        fail(err);
        return;
      }
      // Reduced motion draws only when something changed, or while a drag spin settles.
      if (!reduceMotion || Math.abs(motion.spin) > 0.001) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (visible && !raf && !disposed && state) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }
    dirty.current = wake;

    // Drag to turn the glass by hand. Release to let it spin on.
    let dragging = false;
    let lastX = 0;
    let lastT = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastT = e.timeStamp;
      motion.spin = 0;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const rect = wrap.getBoundingClientRect();
      const worldPerPx = (LAYOUT.viewHeight * FRAMES[live.current.settings.frame].aspect) / rect.width;
      // A point on the front face moves with the cursor: its angle changes by dx / radius.
      const turn = ((e.clientX - lastX) * worldPerPx) / GLASS_RADIUS;
      const seconds = Math.max(0.001, (e.timeStamp - lastT) / 1000);
      motion.phi += turn;
      motion.rodPhi += turn * live.current.settings.rodSpin;
      motion.spin = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, 0.6 * motion.spin + 0.4 * (turn / seconds)));
      lastX = e.clientX;
      lastT = e.timeStamp;
      wake();
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      // Holding still before letting go means no throw.
      if (e.timeStamp - lastT > 80) motion.spin = 0;
      wake();
    };

    // Only animate while on screen; instances scrolled away cost nothing.
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      wake();
    });
    io.observe(wrap);

    // The GPU can drop the context (driver reset, too many contexts). Rebuild when it returns.
    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      raf = 0;
      state = null;
      targets = null;
      hasWallTex = false;
    };
    const onRestored = () => {
      try {
        state = initGL(gl);
        wake();
      } catch (err) {
        fail(err);
      }
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    try {
      state = initGL(gl);
    } catch (err) {
      fail(err);
      return;
    }
    wrap.dataset.ready = "";
    live.current.onReady?.({
      snapshot: () => {
        draw(0); // the drawing buffer is only readable in the same task as the draw
        return canvas.toDataURL("image/png");
      },
      canvas: () => canvas,
    });
    wake();

    if (backdropSrc) {
      loadImage(backdropSrc)
        .then((img) => {
          if (disposed || !state) return;
          bindTexture(gl, 1, state.wallTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          hasWallTex = true;
          wake();
        })
        .catch(fail);
    }

    return () => {
      disposed = true;
      dirty.current = null;
      cancelAnimationFrame(raf);
      io.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      if (!gl.isContextLost()) {
        if (targets) freeTargets(gl, targets);
        if (state) {
          gl.deleteTexture(state.causticTex);
          gl.deleteTexture(state.wallTex);
          gl.deleteBuffer(state.buffer);
          gl.deleteProgram(state.scene.program);
          gl.deleteProgram(state.blur.program);
          gl.deleteProgram(state.composite.program);
        }
      }
      delete wrap.dataset.ready;
    };
  }, [backdropSrc]);

  const look = LANTERN_LOOKS[resolved.look];
  const css = (rgb: RGB) => `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
  return (
    <div ref={wrapRef} role="img" aria-label={alt} className={className} style={{ ...style, position: "relative", aspectRatio: aspect }}>
      {failed ? (
        // Still fallback without WebGL2: the sun's glow on the wall colour.
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 40%, ${css(look.core)} 0%, ${css(look.rim)} 12%, ${css(look.wall)} 55%)` }} />
      ) : (
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "pan-y", cursor: "grab" }} />
      )}
    </div>
  );
}
