"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadImage } from "@/components/imageCache";
import { FOIL_FRAGMENT, FOIL_VERTEX } from "./foilShader";
import { FOILS, mapKey, resolveSettings, type FoilSettingsInput, type RGB } from "./foilSettings";
import { analyse, composeMaps, samplePick, type FoilMaps } from "./prepareFoilMaps";

export { forgetImage } from "@/components/imageCache";
export type { FoilSettingsInput };

/** Imperative handle for tools such as the studio. */
export interface FoilHandle {
  /** PNG of the current frame, as a data URL. */
  snapshot(): string;
  /** The live canvas, for video capture. */
  canvas(): HTMLCanvasElement;
  /** The processed maps, for baking. Null until built or when rendering pre-baked maps. */
  maps(): FoilMaps | null;
}

interface FoilArtProps {
  /** The illustration, or with `fx`, a pre-baked print map. */
  src: string;
  /**
   * Pre-baked fx map exported from the studio. When set, `src` is the baked print and no image
   * processing runs in the browser: only look settings and the foil's flash colour apply.
   */
  fx?: string;
  alt: string;
  settings?: FoilSettingsInput;
  className?: string;
  style?: CSSProperties;
  /** Drag to tilt the art, springing back on release (studio behaviour). */
  tiltable?: boolean;
  /** Called with the colour under a click (no drag). Enables picking. */
  onPick?: (rgb: RGB) => void;
  /** Called after each map build with its duration, for diagnostics. */
  onBuild?: (ms: number, size: { width: number; height: number }) => void;
  onReady?: (handle: FoilHandle) => void;
  onError?: (error: Error) => void;
}

/** Original camera: 30° vertical FOV. Distance that fits the viewport height at that FOV. */
const HALF_FOV_RAD = (15 * Math.PI) / 180;
/** Original maps the pointer's hit point to the lamp with a 1.2x overshoot. */
const LAMP_OVERSHOOT = 1.2;
/** How far the pointer nudges the studio lights, radians at the viewport edge. */
const STUDIO_NUDGE = { x: 0.14, y: 0.09 } as const;
/** Exponential follow rates (1/s): fast while steering, slow while drifting. */
const FOLLOW_RATE_ACTIVE = 9;
const FOLLOW_RATE_IDLE = 3;
const LAMP_ON_RATE = 4;
/** Lamp strength when nobody is steering it. */
const LAMP_IDLE = 0.7;
/** Idle drift: lamp orbits the element when there is no mouse (touch, or pointer left). */
const DRIFT_SPEED = { x: 0.55, y: 0.8 } as const;
const DRIFT_REACH = { x: 0.5, y: 0.36 } as const;
/** Drag-to-tilt, from the original: radians per px, limits, and spring constants. */
const TILT_PER_PX = { x: 0.004, y: 0.005 } as const;
const TILT_MAX = { x: 0.6, y: 0.9 } as const;
const TILT_STIFFNESS = 90;
const TILT_DAMPING = 9;
const TILT_PERSPECTIVE_PX = 1200;
/** Below this angle and speed the spring snaps to rest. */
const TILT_REST = 2e-3;
/** Pointer travel under which a press counts as a click (colour pick), px. */
const CLICK_SLOP_PX = 4;
const MAX_DPR = 2;
/** Max frame delta, so a backgrounded tab does not snap the lamp on return. */
const MAX_DT = 0.05;
/** Coalesce rapid setting changes (slider drags) into one map build. */
const BUILD_DEBOUNCE_MS = 40;

/** Shared pointer state. One set of listeners for every instance on the page. */
const pointer = { x: 0, y: 0, active: false, touching: false };
let pointerListeners = 0;
const onMove = (e: PointerEvent) => {
  if (e.pointerType === "mouse" || pointer.touching) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }
};
const onDown = (e: PointerEvent) => {
  if (e.pointerType === "mouse") return;
  // Touch and pen steer the lamp while pressed, like the original.
  pointer.touching = true;
  onMove(e);
};
const onUp = (e: PointerEvent) => {
  if (e.pointerType === "mouse") return;
  pointer.touching = false;
  pointer.active = false;
};
const onLeave = () => {
  pointer.active = false;
};
function retainPointer() {
  if (pointerListeners++ > 0) return;
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", onDown, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });
  window.addEventListener("pointercancel", onUp, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
}
function releasePointer() {
  if (--pointerListeners > 0) return;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerdown", onDown);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  document.documentElement.removeEventListener("pointerleave", onLeave);
}

interface GLState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  textures: [WebGLTexture, WebGLTexture];
  u: Record<string, WebGLUniformLocation | null>;
}

const UNIFORMS = [
  "uMap", "uFx", "uFxTexel", "uAspect", "uRect", "uViewport", "uCamZ", "uLamp", "uLampOn",
  "uLight", "uTilt", "uTint", "uRelief", "uCrinkle", "uShine", "uGrain",
] as const;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

function initGL(gl: WebGLRenderingContext): GLState {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, FOIL_VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FOIL_FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  // Canvas pixels are straight alpha; keep them raw, the shader premultiplies on output.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // fx holds data, not colour: the browser must not colour-manage it.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.clearColor(0, 0, 0, 0);

  const makeTex = (unit: number) => {
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  const u = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]));
  const textures: [WebGLTexture, WebGLTexture] = [makeTex(0), makeTex(1)];
  gl.uniform1i(u.uMap, 0);
  gl.uniform1i(u.uFx, 1);
  return { gl, program, textures, u };
}

function uploadMaps(state: GLState, maps: FoilMaps) {
  const { gl, textures, u } = state;
  [maps.print, maps.fx].forEach((source, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  });
  const longest = Math.max(maps.width, maps.height);
  gl.uniform2f(u.uFxTexel, 1 / maps.width, 1 / maps.height);
  gl.uniform2f(u.uAspect, maps.width / longest, maps.height / longest);
}

/**
 * An illustration whose foil behaves like hot-foil stamping: a light follows the cursor and the
 * foil flashes where it faces it. Falls back to the plain image without WebGL.
 */
export function FoilArt({ src, fx, alt, settings, className, style, tiltable, onPick, onBuild, onReady, onError }: FoilArtProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const resolved = resolveSettings(settings);
  const key = mapKey(resolved);

  // Values read inside the long-lived effect; synced after every render.
  const live = useRef({ settings: resolved, onPick, onBuild, onReady, onError });
  useEffect(() => {
    live.current = { settings: resolved, onPick, onBuild, onReady, onError };
  });

  // Requests a map rebuild from the long-lived effect when map-affecting settings change.
  const rebuild = useRef<(() => void) | null>(null);
  useEffect(() => {
    rebuild.current?.();
  }, [key]);

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
    let glState: GLState | null = null;
    let image: HTMLImageElement | null = null;
    let maps: FoilMaps | null = null;
    let baked = false;
    let builtKey = "";
    let buildTimer = 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const fail = (err: unknown) => {
      if (disposed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("FoilArt:", error);
      setFailed(true);
      live.current.onError?.(error);
    };

    const build = () => {
      buildTimer = 0;
      if (disposed || !image || !glState || baked) return;
      const s = live.current.settings;
      const k = mapKey(s);
      if (k === builtKey) return;
      try {
        const t0 = performance.now();
        maps = composeMaps(analyse(image, s.shape), s);
        uploadMaps(glState, maps);
        builtKey = k;
        setAspect(maps.width / maps.height);
        live.current.onBuild?.(performance.now() - t0, { width: maps.width, height: maps.height });
        wake();
      } catch (err) {
        fail(err);
      }
    };
    const scheduleBuild = () => {
      if (!buildTimer) buildTimer = window.setTimeout(build, BUILD_DEBOUNCE_MS);
    };
    rebuild.current = scheduleBuild;

    // Lamp state lives in page space (origin viewport centre, y up), eased toward its target.
    const lamp = { x: 0, y: 0, on: LAMP_IDLE, seeded: false };
    const nudge = { x: 0, y: 0 };
    const tilt = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
    let last = performance.now();
    let clock = 0;

    const draw = (dt: number) => {
      if (!glState || !maps) return;
      const { gl, u } = glState;
      clock += dt;
      const rect = wrap.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const camZ = vh / 2 / Math.tan(HALF_FOV_RAD);
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const bw = Math.max(1, Math.round(rect.width * dpr));
      const bh = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      gl.viewport(0, 0, bw, bh);

      const steering = pointer.active;
      let tx: number;
      let ty: number;
      if (steering) {
        tx = LAMP_OVERSHOOT * (pointer.x - vw / 2);
        ty = LAMP_OVERSHOOT * (vh / 2 - pointer.y);
      } else {
        const t = reduceMotion ? 0 : clock;
        tx = rect.left + rect.width / 2 - vw / 2 + DRIFT_REACH.x * rect.width * Math.sin(DRIFT_SPEED.x * t);
        ty = vh / 2 - (rect.top + rect.height / 2) + DRIFT_REACH.y * rect.height * Math.sin(DRIFT_SPEED.y * t + 1.3);
      }
      if (!lamp.seeded) {
        Object.assign(lamp, { x: tx, y: ty, seeded: true });
      }
      const follow = 1 - Math.exp(-dt * (steering ? FOLLOW_RATE_ACTIVE : FOLLOW_RATE_IDLE));
      lamp.x += (tx - lamp.x) * follow;
      lamp.y += (ty - lamp.y) * follow;
      lamp.on += ((steering ? 1 : LAMP_IDLE) - lamp.on) * (1 - Math.exp(-dt * LAMP_ON_RATE));
      const sx = steering ? (pointer.x / vw) * 2 - 1 : 0;
      const sy = steering ? 1 - (pointer.y / vh) * 2 : 0;
      nudge.x += (sx - nudge.x) * follow;
      nudge.y += (sy - nudge.y) * follow;

      // Damped spring toward the drag target (0 when released).
      tilt.vx += ((tilt.tx - tilt.x) * TILT_STIFFNESS - tilt.vx * TILT_DAMPING) * dt;
      tilt.vy += ((tilt.ty - tilt.y) * TILT_STIFFNESS - tilt.vy * TILT_DAMPING) * dt;
      tilt.x += tilt.vx * dt;
      tilt.y += tilt.vy * dt;
      if (tilt.tx === 0 && tilt.ty === 0 && Math.max(Math.abs(tilt.x), Math.abs(tilt.y), Math.abs(tilt.vx), Math.abs(tilt.vy)) < TILT_REST) {
        Object.assign(tilt, { x: 0, y: 0, vx: 0, vy: 0 });
      }
      const tilted = tilt.x !== 0 || tilt.y !== 0;
      canvas.style.transform = tilted
        ? `perspective(${TILT_PERSPECTIVE_PX}px) rotateX(${tilt.x}rad) rotateY(${tilt.y}rad)`
        : "";

      const { look, foil } = live.current.settings;
      const tint = FOILS[foil].tint;
      gl.uniform4f(u.uRect, rect.left, rect.top, rect.width, rect.height);
      gl.uniform2f(u.uViewport, vw, vh);
      gl.uniform1f(u.uCamZ, camZ);
      gl.uniform3f(u.uLamp, lamp.x, lamp.y, look.lampHeight * camZ);
      gl.uniform1f(u.uLampOn, lamp.on);
      gl.uniform2f(u.uLight, STUDIO_NUDGE.x * nudge.x, STUDIO_NUDGE.y * nudge.y);
      gl.uniform2f(u.uTilt, tilt.x, tilt.y);
      gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
      gl.uniform1f(u.uRelief, look.relief);
      gl.uniform1f(u.uCrinkle, look.crinkle);
      gl.uniform1f(u.uShine, look.shine);
      gl.uniform1f(u.uGrain, look.grain);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed || !visible || gl.isContextLost()) return;
      const dt = Math.min(MAX_DT, (now - last) / 1000);
      last = now;
      draw(dt);
      raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (visible && !raf && !disposed) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

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
      glState = null;
    };
    const onRestored = () => {
      try {
        glState = initGL(gl);
        if (maps) uploadMaps(glState, maps);
        wake();
      } catch (err) {
        fail(err);
      }
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    // Drag to tilt, click to pick.
    let press: { x: number; y: number; id: number; moved: boolean } | null = null;
    const onPress = (e: PointerEvent) => {
      if (e.button !== 0) return;
      press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
      if (tiltable && e.pointerType === "mouse") {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // The pointer is already gone (released between events); dragging still works uncaptured.
        }
      }
    };
    const onDrag = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (Math.hypot(dx, dy) > CLICK_SLOP_PX) press.moved = true;
      if (tiltable && e.pointerType === "mouse" && press.moved) {
        tilt.ty = Math.max(-TILT_MAX.y, Math.min(TILT_MAX.y, dx * TILT_PER_PX.y));
        tilt.tx = Math.max(-TILT_MAX.x, Math.min(TILT_MAX.x, -dy * TILT_PER_PX.x));
        wrap.dataset.grabbing = "";
      }
    };
    const onRelease = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const clicked = !press.moved;
      press = null;
      tilt.tx = 0;
      tilt.ty = 0;
      delete wrap.dataset.grabbing;
      const pick = live.current.onPick;
      if (clicked && pick && image) {
        const rect = wrap.getBoundingClientRect();
        const an = analyse(image, live.current.settings.shape);
        pick(samplePick(an, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height));
      }
    };
    canvas.addEventListener("pointerdown", onPress);
    canvas.addEventListener("pointermove", onDrag);
    canvas.addEventListener("pointerup", onRelease);
    canvas.addEventListener("pointercancel", onRelease);

    retainPointer();
    Promise.all([loadImage(src), fx ? loadImage(fx) : null])
      .then(([img, fxImg]) => {
        if (disposed) return;
        glState = initGL(gl);
        if (fxImg) {
          if (fxImg.naturalWidth !== img.naturalWidth || fxImg.naturalHeight !== img.naturalHeight) {
            throw new Error("Baked print and fx maps must be the same size");
          }
          baked = true;
          maps = { print: img, fx: fxImg, width: img.naturalWidth, height: img.naturalHeight };
          uploadMaps(glState, maps);
          setAspect(maps.width / maps.height);
          wake();
        } else {
          image = img;
          build();
        }
        wrap.dataset.ready = "";
        live.current.onReady?.({
          snapshot: () => {
            draw(0); // the drawing buffer is only readable in the same task as the draw
            return canvas.toDataURL("image/png");
          },
          canvas: () => canvas,
          maps: () => (baked ? null : maps),
        });
      })
      .catch(fail);

    return () => {
      disposed = true;
      rebuild.current = null;
      cancelAnimationFrame(raf);
      clearTimeout(buildTimer);
      io.disconnect();
      releasePointer();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.removeEventListener("pointerdown", onPress);
      canvas.removeEventListener("pointermove", onDrag);
      canvas.removeEventListener("pointerup", onRelease);
      canvas.removeEventListener("pointercancel", onRelease);
      if (glState && !gl.isContextLost()) {
        gl.deleteTexture(glState.textures[0]);
        gl.deleteTexture(glState.textures[1]);
        gl.deleteProgram(glState.program);
      }
      delete wrap.dataset.ready;
    };
  }, [src, fx, tiltable]);

  return (
    <div
      ref={wrapRef}
      role="img"
      aria-label={alt}
      className={className}
      style={{ ...style, position: "relative", aspectRatio: aspect ?? undefined }}
    >
      {failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- plain fallback for the WebGL canvas
        <img src={src} alt="" style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }} />
      ) : (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: tiltable ? "none" : "auto",
            cursor: onPick ? "crosshair" : tiltable ? "grab" : undefined,
          }}
        />
      )}
    </div>
  );
}
