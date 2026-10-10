"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FoilArt, forgetImage, type FoilHandle } from "./FoilArt";
import {
  DEFAULT_LOOK,
  DEFAULT_SETTINGS,
  FOILS,
  FOIL_MODES,
  PAPERS,
  SHAPES,
  resolveSettings,
  type FoilKey,
  type FoilLook,
  type FoilMode,
  type FoilSettings,
  type Ground,
  type PaperKey,
  type ShapeKey,
} from "./foilSettings";

interface Stage {
  background: string;
  /** Preview width, percent of the stage. */
  width: number;
}

interface Saved {
  settings: FoilSettings;
  stage: Stage;
}

const STORAGE_KEY = "foil-studio:v2";
const SAMPLES = [
  { src: "/foil/umbrella.png", name: "umbrella.png" },
  { src: "/foil/demo.svg", name: "demo.svg" },
] as const;
const DEFAULT_STAGE: Stage = { background: "#f4f1ea", width: 60 };
const COPIED_MS = 1500;
/** Surprise me picks "details" three times as often as "darks", as the original does. */
const SURPRISE_MODES: FoilMode[] = ["details", "details", "details", "darks"];
const SURPRISE_BORDER_CHANCE = 0.4;

const rgbCss = (rgb: readonly number[]) => `rgb(${rgb.join(", ")})`;
const round = (v: number, places: number) => Number(v.toFixed(places));
const pickRandom = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

/** JSX for the site, listing only values that differ from the defaults. */
function snippet(s: FoilSettings, fileName: string): string {
  const diff: string[] = [];
  const keys = ["mode", "amount", "pick", "border", "foil", "ground", "shape", "softness"] as const;
  for (const k of keys) {
    if (JSON.stringify(s[k]) === JSON.stringify(DEFAULT_SETTINGS[k])) continue;
    if (k === "pick" && s.mode !== "colour") continue;
    const v = s[k];
    diff.push(`${k}: ${typeof v === "number" ? round(v, 3) : JSON.stringify(v)}`);
  }
  const look = (Object.keys(DEFAULT_LOOK) as (keyof FoilLook)[])
    .filter((k) => s.look[k] !== DEFAULT_LOOK[k])
    .map((k) => `${k}: ${round(s.look[k], 3)}`);
  if (look.length) diff.push(`look: { ${look.join(", ")} }`);
  const settings = diff.length ? `\n  settings={{ ${diff.join(", ")} }}` : "";
  return `<FoilArt\n  src="/${fileName}"\n  alt=""${settings}\n/>`;
}

/** JSX for pre-baked maps: no processing in the browser, only the finish settings apply. */
function bakedSnippet(s: FoilSettings, base: string): string {
  const look = (Object.keys(DEFAULT_LOOK) as (keyof FoilLook)[])
    .filter((k) => s.look[k] !== DEFAULT_LOOK[k])
    .map((k) => `${k}: ${round(s.look[k], 3)}`);
  const parts = [s.foil !== DEFAULT_SETTINGS.foil ? `foil: "${s.foil}"` : "", look.length ? `look: { ${look.join(", ")} }` : ""].filter(Boolean);
  const settings = parts.length ? `\n  settings={{ ${parts.join(", ")} }}` : "";
  return `<FoilArt\n  src="/${base}-print.png"\n  fx="/${base}-fx.png"\n  alt=""${settings}\n/>`;
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string; testId?: string }) {
  return (
    <label className="block">
      <span className="flex justify-between text-[12px]">
        <span>{props.label}</span>
        <span className="tabular-nums text-black/50">{round(props.value, 3)}</span>
      </span>
      <input
        type="range"
        data-testid={props.testId}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-black"
      />
      {props.hint && <span className="block text-[11px] text-black/45">{props.hint}</span>}
    </label>
  );
}

function Section({ n, title, action, children }: { n: number; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-black/10 px-5 py-4">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-black text-[10px] text-white">{n}</span>
        {title}
        {action && <span className="ml-auto">{action}</span>}
      </h2>
      {children}
    </section>
  );
}

function Choice<T extends string>(props: { value: T; current: T; onSelect: (v: T) => void; children: ReactNode; title?: string }) {
  const on = props.value === props.current;
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={on}
      onClick={() => props.onSelect(props.value)}
      className={`rounded-md border px-2.5 py-1.5 ${on ? "border-black bg-black text-white" : "border-black/15 bg-white hover:bg-black/[0.03]"}`}
    >
      {props.children}
    </button>
  );
}

/** Drop an illustration, tune the foil, copy the props for the site. Settings persist locally. */
export function FoilStudio() {
  const [settings, setSettings] = useState<FoilSettings>(DEFAULT_SETTINGS);
  const [stage, setStage] = useState<Stage>(DEFAULT_STAGE);
  const [src, setSrc] = useState<string>(SAMPLES[0].src);
  const [fileName, setFileName] = useState<string>(SAMPLES[0].name);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Loading…");
  const [menuOpen, setMenuOpen] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const handle = useRef<FoilHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  // Restore after mount so server and client render the same first frame.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Saved> | null;
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from storage
        setSettings(resolveSettings(saved.settings));
        setStage({ ...DEFAULT_STAGE, ...saved.stage });
      }
    } catch {
      // Corrupt storage: keep defaults.
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, stage } satisfies Saved));
  }, [settings, stage, hydrated]);

  // Free the previous object URL when the image changes.
  useEffect(
    () => () => {
      if (src.startsWith("blob:")) {
        URL.revokeObjectURL(src);
        forgetImage(src);
      }
    },
    [src],
  );

  const set = useCallback((patch: Partial<FoilSettings>) => setSettings((s) => resolveSettings({ ...s, ...patch })), []);
  const setLook = (patch: Partial<FoilLook>) => setSettings((s) => ({ ...s, look: { ...s.look, ...patch } }));
  const setMode = (mode: FoilMode) => set({ mode, amount: FOIL_MODES[mode].defaultAmount });

  const loadFile = useCallback((file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(`“${file.name}” isn't an image. Try a PNG, JPG, WebP or SVG.`);
      return;
    }
    setError(null);
    setStatus("Loading…");
    setSrc(URL.createObjectURL(file));
    setFileName(file.name);
  }, []);

  // Paste an image from the clipboard, as the original allows.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Leave pastes into text fields alone. The target can be window/document, not an Element.
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        loadFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadFile]);

  const surprise = () => {
    const next = pickRandom(SURPRISE_MODES);
    set({
      mode: next,
      amount: FOIL_MODES[next].defaultAmount,
      foil: pickRandom(Object.keys(FOILS) as FoilKey[]),
      border: Math.random() < SURPRISE_BORDER_CHANCE,
    });
  };

  const flash = (label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), COPIED_MS);
  };
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const [output, setOutput] = useState<"live" | "baked">("baked");
  const code = output === "baked" ? bakedSnippet(settings, baseName) : snippet(settings, fileName);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flash("jsx");
    } catch {
      // Clipboard can be blocked (permissions, insecure origin). Select the text instead.
      const pre = document.querySelector<HTMLElement>("[data-testid=snippet]");
      if (pre) window.getSelection()?.selectAllChildren(pre);
      setError("Couldn't reach the clipboard. The code is selected: press ⌘C / Ctrl+C.");
    }
  };
  const download = (href: string, name: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
  };
  const savePng = () => {
    if (handle.current) download(handle.current.snapshot(), `${baseName}-foil.png`);
  };
  const downloadBaked = () => {
    const maps = handle.current?.maps();
    if (!maps) return;
    for (const [part, source] of [["print", maps.print], ["fx", maps.fx]] as const) {
      if (source instanceof HTMLCanvasElement) download(source.toDataURL("image/png"), `${baseName}-${part}.png`);
    }
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    download(url, `${baseName}-foil.json`);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      setSettings(resolveSettings(JSON.parse(await file.text())));
      setError(null);
    } catch {
      setError(`“${file.name}” isn't a valid settings file.`);
    }
  };

  const mode = FOIL_MODES[settings.mode];
  const showAmount = settings.mode !== "all" && (settings.mode !== "colour" || settings.pick);

  return (
    <div className={`fixed inset-0 z-[200] grid bg-white text-[13px] text-[#111] ${menuOpen ? "grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-1"}`}>
      <div
        className="relative flex items-center justify-center overflow-hidden"
        style={{ background: stage.background }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          loadFile(e.dataTransfer.files[0]);
        }}
      >
        <FoilArt
          key={src}
          src={src}
          alt={fileName}
          settings={settings}
          tiltable
          onPick={settings.mode === "colour" ? (pick) => set({ pick }) : undefined}
          onReady={(h) => (handle.current = h)}
          onBuild={(ms, size) => setStatus(`${size.width}×${size.height} map · built in ${Math.round(ms)} ms`)}
          onError={(err) => setStatus(`Couldn't render: ${err.message}`)}
          style={{ width: `${stage.width}%`, maxHeight: "92%" }}
        />
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="absolute right-3 top-3 rounded-md border border-black/15 bg-white/80 px-2.5 py-1 text-[12px] backdrop-blur"
        >
          {menuOpen ? "Hide the menu" : "Show the menu"}
        </button>
        <p className="pointer-events-none absolute bottom-4 left-0 right-0 text-center text-[12px] text-black/45">
          {settings.mode === "colour" && !settings.pick
            ? "Click the picture to choose the colour that turns to foil."
            : "Move the mouse to steer the light · drag to tilt · drop or paste a picture"}
        </p>
        {dragging && (
          <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-black/30 bg-white/70 text-[15px] font-semibold backdrop-blur-sm">
            Drop your picture
          </div>
        )}
      </div>

      {menuOpen && (
        <aside className="overflow-y-auto overscroll-contain border-l border-black/10 bg-[#fcfcfb]">
          <header className="px-5 pb-2 pt-5">
            <h1 className="text-[20px] font-semibold tracking-tight">Foil studio</h1>
            <p className="text-black/55">Turn an illustration into hot-foil stamping that catches the cursor&apos;s light.</p>
            <p data-testid="status" className="mt-1 text-[11px] tabular-nums text-black/45">{status}</p>
          </header>
          {error && (
            // Sticky, so errors from any section stay visible.
            <div role="alert" className="sticky top-0 z-10 mx-5 flex items-start gap-2 rounded-md bg-red-50 px-2 py-1.5 text-[12px] text-red-700">
              <span className="flex-1">{error}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
                ×
              </button>
            </div>
          )}

          <Section n={1} title="Your picture">
            <div className="flex gap-2">
              <button type="button" onClick={() => fileInput.current?.click()} className="flex-1 rounded-md border border-black/15 bg-white px-3 py-2 hover:bg-black/[0.03]">
                {src.startsWith("blob:") ? "Change picture" : "Upload a picture"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  loadFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="text-[11px] text-black/50">or drop or paste one. It stays in your browser.</p>
            <p className="truncate text-[11px] text-black/50">Now: {fileName}</p>
            <div className="flex flex-wrap gap-2 text-[12px]">
              <span className="text-black/50">Samples:</span>
              {SAMPLES.map((s) => (
                <button
                  key={s.src}
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    setSrc(s.src);
                    setFileName(s.name);
                    setError(null);
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div className="text-[12px] text-black/60">Shape</div>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(SHAPES) as ShapeKey[]).map((k) => (
                <Choice key={k} value={k} current={settings.shape} onSelect={(shape) => set({ shape })}>
                  {SHAPES[k].name}
                </Choice>
              ))}
            </div>
          </Section>

          <Section
            n={2}
            title="What turns to foil"
            action={
              <button type="button" onClick={surprise} className="text-[12px] font-normal underline underline-offset-2">
                Surprise me
              </button>
            }
          >
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(FOIL_MODES) as FoilMode[]).map((k) => (
                <Choice key={k} value={k} current={settings.mode} onSelect={setMode} title={FOIL_MODES[k].hint}>
                  {FOIL_MODES[k].name}
                </Choice>
              ))}
            </div>
            <p className="text-[11px] text-black/50">{mode.hint}</p>
            {settings.mode === "colour" && (
              <div className="flex items-center gap-2 text-[12px]">
                <span
                  data-testid="pick-swatch"
                  className="h-5 w-5 rounded border border-black/15"
                  style={{ background: settings.pick ? rgbCss(settings.pick) : "repeating-linear-gradient(45deg,#eee 0 4px,#fff 4px 8px)" }}
                />
                {settings.pick ? `Picked ${rgbCss(settings.pick)}` : "No colour picked yet"}
              </div>
            )}
            {showAmount && (
              <Slider
                testId="amount"
                label={settings.mode === "colour" ? "How close a colour" : "How much foil"}
                value={settings.amount}
                min={mode.range[0]}
                max={mode.range[1]}
                step={0.005}
                onChange={(amount) => set({ amount })}
              />
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.border} onChange={(e) => set({ border: e.target.checked })} />
              A foil border round the edge
            </label>
          </Section>

          <Section n={3} title="Foil colour">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(FOILS) as FoilKey[]).map((k) => {
                const f = FOILS[k];
                return (
                  <button
                    key={k}
                    type="button"
                    title={f.name}
                    aria-pressed={settings.foil === k}
                    onClick={() => set({ foil: k })}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${settings.foil === k ? "border-black" : "border-black/15"}`}
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: "holo" in f ? "conic-gradient(#f9c, #9cf, #cf9, #fc9, #f9c)" : rgbCss(f.ink) }}
                    />
                    {f.name}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section n={4} title="Background">
            <div className="flex flex-wrap gap-2">
              <Choice value={"transparent" as Ground} current={settings.ground} onSelect={(ground) => set({ ground })}>
                Cut out
              </Choice>
              <Choice value={"keep" as Ground} current={settings.ground} onSelect={(ground) => set({ ground })}>
                Keep
              </Choice>
            </div>
            <div className="text-[12px] text-black/60">Or repaint it as paper</div>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PAPERS) as PaperKey[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  title={PAPERS[k].name}
                  aria-label={PAPERS[k].name}
                  aria-pressed={settings.ground === k}
                  onClick={() => set({ ground: k })}
                  className={`h-7 w-7 rounded-full border-2 ${settings.ground === k ? "border-black" : "border-black/10"}`}
                  style={{ background: rgbCss(PAPERS[k].rgb) }}
                />
              ))}
            </div>
            <p className="text-[11px] text-black/50">Works when the picture sits on a plain, light background.</p>
          </Section>

          <Section
            n={5}
            title="Finish"
            action={
              <button type="button" onClick={() => set({ look: DEFAULT_LOOK, softness: DEFAULT_SETTINGS.softness })} className="text-[12px] font-normal underline underline-offset-2">
                Reset
              </button>
            }
          >
            <Slider testId="relief" label="Relief" value={settings.look.relief} min={0} max={8} step={0.1} onChange={(v) => setLook({ relief: v })} hint="How deep the stamp presses." />
            <Slider testId="softness" label="Softness" value={settings.softness} min={0} max={8} step={1} onChange={(v) => set({ softness: v })} hint="Rounder, puffier edges. Rebuilds the maps." />
            <Slider testId="crinkle" label="Crinkle" value={settings.look.crinkle} min={0} max={1} step={0.01} onChange={(v) => setLook({ crinkle: v })} hint="Fine texture in the metal." />
            <Slider testId="shine" label="Shine" value={settings.look.shine} min={0} max={3} step={0.05} onChange={(v) => setLook({ shine: v })} hint="Strength of the white-hot flash." />
            <Slider testId="lamp" label="Lamp height" value={settings.look.lampHeight} min={0.05} max={0.8} step={0.01} onChange={(v) => setLook({ lampHeight: v })} hint="Low = tight torch, high = broad wash." />
            <Slider testId="grain" label="Paper grain" value={settings.look.grain} min={0} max={3} step={0.05} onChange={(v) => setLook({ grain: v })} />
          </Section>

          <Section n={6} title="Stage">
            <label className="flex items-center gap-2">
              <input type="color" value={stage.background} onChange={(e) => setStage((s) => ({ ...s, background: e.target.value }))} />
              Preview background (your site colour)
            </label>
            <Slider label="Size %" value={stage.width} min={20} max={100} step={1} onChange={(width) => setStage((s) => ({ ...s, width }))} />
          </Section>

          <Section n={7} title="Use it">
            <div className="flex gap-2">
              <Choice value={"baked" as const} current={output} onSelect={setOutput} title="Ship the two processed maps. Nothing is computed on the visitor's device.">
                Baked (fastest)
              </Choice>
              <Choice value={"live" as const} current={output} onSelect={setOutput} title="Ship the original picture. Maps are computed in the browser on load.">
                Live
              </Choice>
            </div>
            {output === "baked" && (
              <button type="button" onClick={downloadBaked} className="w-full rounded-md border border-black/15 px-3 py-2">
                Download {baseName}-print.png + {baseName}-fx.png
              </button>
            )}
            <pre data-testid="snippet" className="overflow-x-auto whitespace-pre-wrap rounded-md bg-black/[0.04] p-3 text-[11px] leading-relaxed">{code}</pre>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={copyCode} className="col-span-2 rounded-md bg-black px-3 py-2 text-white">
                {copied === "jsx" ? "Copied" : "Copy JSX"}
              </button>
              <button type="button" onClick={savePng} className="rounded-md border border-black/15 px-3 py-2">
                Save PNG
              </button>
              <button type="button" onClick={exportJson} className="rounded-md border border-black/15 px-3 py-2">
                Export settings
              </button>
              <button type="button" onClick={() => importInput.current?.click()} className="rounded-md border border-black/15 px-3 py-2">
                Import settings
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettings(DEFAULT_SETTINGS);
                  setStage(DEFAULT_STAGE);
                }}
                className="rounded-md border border-black/15 px-3 py-2"
              >
                Reset all
              </button>
              <input
                ref={importInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  importJson(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="text-[11px] text-black/50">
              {output === "baked"
                ? "Put both files in /public, then paste the JSX. Re-download after changing anything above Finish."
                : "Put the picture in /public under the same name, then paste the JSX."}
            </p>
          </Section>
        </aside>
      )}
    </div>
  );
}
