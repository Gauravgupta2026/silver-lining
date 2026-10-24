"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadImage } from "@/components/imageCache";
import { CRT_LOOKS, resolveCrtSettings, type CrtSettings, type CrtSettingsInput } from "./crtSettings";
import { CRT_BLUR_FRAGMENT, CRT_COMPOSITE_FRAGMENT, CRT_SCENE_FRAGMENT, CRT_VERTEX } from "./crtShader";
import { buildGlyphAtlas, cellRows, LIGHT_BORDER, prepareSource, type GlyphAtlas, type PreparedSource } from "./prepareCrtMaps";

export type { CrtSettingsInput };

/** Imperative handle for tools such as the studio. */
export interface CrtHandle {
  /** PNG of the current frame, as a data URL. */
  snapshot(): string;
  /** The live canvas, for video capture. */
  canvas(): HTMLCanvasElement;
}

interface CrtArtProps {
  src: string;
  alt: string;
  settings?: CrtSettingsInput;
  className?: string;
  style?: CSSProperties;
  /** Called after the picture is first drawn, and after each re-prepare, with the picture size. */
  onBuild?: (size: { width: number; height: number }) => void;
  onReady?: (handle: CrtHandle) => void;
  onError?: (error: Error) => void;
}

/** Scene pixels per cell across, capped by the scene's side limit. */
const SCENE_PX_PER_CELL = 8;
const MAX_SCENE_WIDTH = 2048;
const MIN_SCENE_WIDTH = 512;
/** Bloom pyramid: each level is this many times smaller than the scene. */
const BLOOM_DIVISORS = [2, 8, 32] as const;
/** Scene brightness (0-1) above which light spills into the bloom. */
const BLOOM_THRESHOLD = 0.2;
const MAX_DPR = 2;
/** Backing store never exceeds this many device pixels, so huge screens stay smooth. */
const MAX_CANVAS_PIXELS = 4_200_000;
/** Max frame delta, so a backgrounded tab does not jump on return. */
const MAX_DT = 0.05;
const POWER_ON_SECONDS = 1.1;
/** Grain size in CSS px; the shader scales it by the pixel ratio. */
const GRAIN_CSS_PX = 0.6;
const POINTER_FOLLOW_RATE = 14;
const POINTER_PRESENCE_RATE = 6;
/** The cursor counts as "near" within this share of the picture beyond its edge. */
const POINTER_REACH = 0.08;

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
  srcTex: WebGLTexture;
  glyphTex: WebGLTexture;
  buffer: WebGLBuffer;
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

function link(gl: WebGLRenderingContext, fragment: string, names: readonly string[]): Program {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, CRT_VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  return { program, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) };
}

const SCENE_UNIFORMS = ["uSrc", "uGlyphs", "uCells", "uGlyphCount", "uGlyphMix", "uStagger", "uInvert", "uExposure", "uContrast", "uRamp"] as const;
const BLUR_UNIFORMS = ["uTex", "uDir", "uExtract", "uThreshold"] as const;
const COMPOSITE_UNIFORMS = [
  "uScene", "uB1", "uB2", "uB3", "uCanvas", "uPic", "uCurve", "uBezel", "uMaskKind", "uMaskCols", "uMaskRows", "uMaskPeriod",
  "uMaskStrength", "uScan", "uGain", "uBloom", "uGrain", "uGrainPx", "uAberration", "uSparkle", "uSpeckColour", "uFocus", "uFlicker", "uRoll", "uGlitch", "uLens",
  "uTime", "uPower", "uCalm", "uPointer",
] as const;

function initGL(gl: WebGLRenderingContext): GLState {
  const scene = link(gl, CRT_SCENE_FRAGMENT, SCENE_UNIFORMS);
  const blur = link(gl, CRT_BLUR_FRAGMENT, BLUR_UNIFORMS);
  const composite = link(gl, CRT_COMPOSITE_FRAGMENT, COMPOSITE_UNIFORMS);

  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  return { scene, blur, composite, srcTex: makeTexture(gl), glyphTex: makeTexture(gl), buffer };
}

function makeTexture(gl: WebGLRenderingContext) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeTarget(gl: WebGLRenderingContext, w: number, h: number): Target {
  const tex = makeTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}

function freeTarget(gl: WebGLRenderingContext, t: Target) {
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

function bindTexture(gl: WebGLRenderingContext, unit: number, tex: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

/** Chain of render targets: scene, then two per bloom level (horizontal, then vertical pass). */
interface Targets {
  scene: Target;
  bloom: { a: Target; b: Target }[];
}

function makeTargets(gl: WebGLRenderingContext, columns: number, aspect: number): Targets {
  const w = Math.round(Math.min(MAX_SCENE_WIDTH, Math.max(MIN_SCENE_WIDTH, columns * SCENE_PX_PER_CELL)));
  const h = Math.max(2, Math.round(w / aspect));
  const scene = makeTarget(gl, w, h);
  const bloom = BLOOM_DIVISORS.map((d) => {
    const bw = Math.max(2, Math.round(w / d));
    const bh = Math.max(2, Math.round(h / d));
    return { a: makeTarget(gl, bw, bh), b: makeTarget(gl, bw, bh) };
  });
  return { scene, bloom };
}

function freeTargets(gl: WebGLRenderingContext, t: Targets) {
  freeTarget(gl, t.scene);
  t.bloom.forEach(({ a, b }) => {
    freeTarget(gl, a);
    freeTarget(gl, b);
  });
}

/**
 * A picture shown on an old CRT screen: cell mosaic, phosphor mask, bloom, grain, curved glass and
 * a bezel. Falls back to the plain picture without WebGL.
 */
export function CrtArt({ src, alt, settings, className, style, onBuild, onReady, onError }: CrtArtProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const resolved = resolveCrtSettings(settings);

  // Values read inside the long-lived effect; synced after every render.
  const live = useRef({ settings: resolved, onBuild, onReady, onError });
  const dirty = useRef<(() => void) | null>(null);
  useEffect(() => {
    live.current = { settings: resolved, onBuild, onReady, onError };
    dirty.current?.();
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
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
    let image: HTMLImageElement | null = null;
    let prepared: PreparedSource | null = null;
    let atlas: GlyphAtlas | null = null;
    let atlasKind = "";
    let preparedColumns = 0;
    let sceneDirty = true;
    let clock = 0;
    let last = performance.now();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let power = reduceMotion ? 1 : 0;
    /** Power-on follows wall-clock time, so slow frames do not stretch it. */
    let powerStart = 0;

    const fail = (err: unknown) => {
      if (disposed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("CrtArt:", error);
      setFailed(true);
      live.current.onError?.(error);
    };

    /** Rebuild whatever the current settings invalidated on the CPU side. */
    const prepare = () => {
      if (!image || !state) return;
      const s = live.current.settings;
      if (!prepared || preparedColumns !== s.columns) {
        prepared = prepareSource(image, s.columns);
        preparedColumns = s.columns;
        bindTexture(gl, 0, state.srcTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prepared.canvas);
        if (targets) freeTargets(gl, targets);
        targets = makeTargets(gl, s.columns, prepared.aspect);
        setAspect(prepared.aspect);
        live.current.onBuild?.({ width: image.naturalWidth, height: image.naturalHeight });
      }
      if (!atlas || atlasKind !== s.glyphs) {
        atlas = buildGlyphAtlas(s.glyphs);
        atlasKind = s.glyphs;
        bindTexture(gl, 1, state.glyphTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
      }
    };

    const drawQuad = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const setTarget = (t: Target | null, w: number, h: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, w, h);
    };

    /** Scene pass plus the bloom pyramid. Runs on setting and picture changes only. */
    const renderScene = (s: CrtSettings) => {
      if (!state || !targets || !prepared || !atlas) return;
      const { scene, blur } = state;
      const t = targets;
      const invert = s.invert === "on" || (s.invert === "auto" && prepared.borderLuma > LIGHT_BORDER);

      gl.useProgram(scene.program);
      bindTexture(gl, 0, state.srcTex);
      bindTexture(gl, 1, state.glyphTex);
      gl.uniform1i(scene.u.uSrc, 0);
      gl.uniform1i(scene.u.uGlyphs, 1);
      gl.uniform2f(scene.u.uCells, s.columns, cellRows(s.columns, prepared.aspect, s.glyphs));
      gl.uniform1f(scene.u.uGlyphCount, atlas.count);
      gl.uniform1f(scene.u.uGlyphMix, s.glyphMix);
      gl.uniform1f(scene.u.uStagger, atlas.stagger ? 1 : 0);
      gl.uniform1f(scene.u.uInvert, invert ? 1 : 0);
      gl.uniform1f(scene.u.uExposure, s.exposure);
      gl.uniform1f(scene.u.uContrast, s.contrast);
      gl.uniform3fv(scene.u.uRamp, new Float32Array(CRT_LOOKS[s.look].ramp.flatMap((rgb) => rgb.map((v) => v / 255))));
      setTarget(t.scene, t.scene.w, t.scene.h);
      drawQuad();

      gl.useProgram(blur.program);
      gl.uniform1i(blur.u.uTex, 0);
      gl.uniform1f(blur.u.uThreshold, BLOOM_THRESHOLD);
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
    };

    // Cursor state in canvas uv (y up), eased so the lens glides.
    const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, z: 0, target: 0, seen: false };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const rect = wrap.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      const v = 1 - (e.clientY - rect.top) / rect.height;
      const near = u > -POINTER_REACH && u < 1 + POINTER_REACH && v > -POINTER_REACH && v < 1 + POINTER_REACH;
      pointer.target = near ? 1 : 0;
      if (near) {
        if (!pointer.seen) Object.assign(pointer, { x: u, y: v, seen: true });
        pointer.tx = u;
        pointer.ty = v;
      }
    };
    const onLeave = () => {
      pointer.target = 0;
    };

    const draw = (dt: number) => {
      if (!state || !targets || !prepared || !atlas) return;
      const s = live.current.settings;
      clock += dt;
      if (power < 1) {
        if (!powerStart) powerStart = performance.now();
        power = Math.min(1, (performance.now() - powerStart) / 1000 / POWER_ON_SECONDS);
      }

      prepare();
      if (sceneDirty) {
        sceneDirty = false;
        renderScene(s);
      }

      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, rect.width * dpr * rect.height * dpr)));
      const bw = Math.max(1, Math.round(rect.width * dpr * fit));
      const bh = Math.max(1, Math.round(rect.height * dpr * fit));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      const follow = 1 - Math.exp(-dt * POINTER_FOLLOW_RATE);
      pointer.x += (pointer.tx - pointer.x) * follow;
      pointer.y += (pointer.ty - pointer.y) * follow;
      pointer.z += (pointer.target - pointer.z) * (1 - Math.exp(-dt * POINTER_PRESENCE_RATE));

      const { composite } = state;
      const bz = s.bezel * 2;
      const maskRows = s.maskDensity / prepared.aspect;
      gl.useProgram(composite.program);
      setTarget(null, bw, bh);
      bindTexture(gl, 0, targets.scene.tex);
      bindTexture(gl, 1, targets.bloom[0].b.tex);
      bindTexture(gl, 2, targets.bloom[1].b.tex);
      bindTexture(gl, 3, targets.bloom[2].b.tex);
      gl.uniform1i(composite.u.uScene, 0);
      gl.uniform1i(composite.u.uB1, 1);
      gl.uniform1i(composite.u.uB2, 2);
      gl.uniform1i(composite.u.uB3, 3);
      gl.uniform2f(composite.u.uCanvas, bw, bh);
      gl.uniform2f(composite.u.uPic, s.columns, cellRows(s.columns, prepared.aspect, s.glyphs));
      gl.uniform1f(composite.u.uCurve, s.curve);
      gl.uniform1f(composite.u.uBezel, s.bezel);
      gl.uniform1f(composite.u.uMaskKind, s.mask === "none" ? 0 : s.mask === "grille" ? 1 : 2);
      gl.uniform1f(composite.u.uMaskCols, s.maskDensity);
      gl.uniform1f(composite.u.uMaskRows, maskRows);
      gl.uniform1f(composite.u.uMaskPeriod, (bw * (1 - bz)) / s.maskDensity);
      gl.uniform1f(composite.u.uMaskStrength, s.maskStrength);
      gl.uniform1f(composite.u.uScan, s.scanlines);
      gl.uniform1f(composite.u.uGain, 1);
      gl.uniform1f(composite.u.uBloom, s.bloom);
      gl.uniform1f(composite.u.uGrain, s.grain);
      gl.uniform1f(composite.u.uGrainPx, Math.max(1, GRAIN_CSS_PX * dpr * fit));
      gl.uniform1f(composite.u.uAberration, s.aberration);
      gl.uniform1f(composite.u.uSparkle, s.sparkle);
      gl.uniform3fv(composite.u.uSpeckColour, new Float32Array(CRT_LOOKS[s.look].ramp[4].map((v) => v / 255)));
      gl.uniform1f(composite.u.uFocus, s.focus);
      gl.uniform1f(composite.u.uFlicker, s.flicker);
      gl.uniform1f(composite.u.uRoll, s.roll);
      gl.uniform1f(composite.u.uGlitch, s.glitch);
      gl.uniform1f(composite.u.uLens, s.lens);
      gl.uniform1f(composite.u.uTime, clock);
      gl.uniform1f(composite.u.uPower, power);
      gl.uniform1f(composite.u.uCalm, reduceMotion ? 1 : 0);
      gl.uniform3f(composite.u.uPointer, pointer.x, pointer.y, pointer.z);
      gl.clear(gl.COLOR_BUFFER_BIT);
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
      // Reduced motion draws only when something changed (or while the power-on settles).
      if (!reduceMotion || power < 1 || pointer.z > 0.001 || pointer.target > 0) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (visible && !raf && !disposed && state && prepared) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }
    dirty.current = () => {
      sceneDirty = true;
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
      prepared = null;
      atlas = null;
    };
    const onRestored = () => {
      try {
        state = initGL(gl);
        sceneDirty = true;
        prepare();
        wake();
      } catch (err) {
        fail(err);
      }
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);

    loadImage(src)
      .then((img) => {
        if (disposed) return;
        image = img;
        state = initGL(gl);
        prepare();
        wrap.dataset.ready = "";
        wake();
        live.current.onReady?.({
          snapshot: () => {
            draw(0); // the drawing buffer is only readable in the same task as the draw
            return canvas.toDataURL("image/png");
          },
          canvas: () => canvas,
        });
      })
      .catch(fail);

    return () => {
      disposed = true;
      dirty.current = null;
      cancelAnimationFrame(raf);
      io.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      if (!gl.isContextLost()) {
        if (targets) freeTargets(gl, targets);
        if (state) {
          gl.deleteTexture(state.srcTex);
          gl.deleteTexture(state.glyphTex);
          gl.deleteBuffer(state.buffer);
          gl.deleteProgram(state.scene.program);
          gl.deleteProgram(state.blur.program);
          gl.deleteProgram(state.composite.program);
        }
      }
      delete wrap.dataset.ready;
    };
  }, [src]);

  return (
    <div ref={wrapRef} role="img" aria-label={alt} className={className} style={{ ...style, position: "relative", aspectRatio: aspect ?? undefined }}>
      {failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- plain fallback for the WebGL canvas
        <img src={src} alt="" style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }} />
      ) : (
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
      )}
    </div>
  );
}
