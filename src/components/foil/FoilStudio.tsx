"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SiteNav } from "@/components/SiteNav";
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

const STORAGE_KEY = "foil-studio:v3";
const SAMPLES = [
  { src: "/foil/umbrella.png", name: "umbrella.png" },
  { src: "/foil/demo.svg", name: "demo.svg" },
] as const;
const DEFAULT_STAGE: Stage = { background: "#ffffff", width: 60 };
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

/** Secondary action: transparent, 1px ink border, 8px radius. Indigo is reserved for the one primary. */
const GHOST = "rounded-control border border-ink bg-transparent px-[18px] py-2 text-body-sm transition-colors hover:bg-ink hover:text-paper";
/** Annotation text: mono with positive tracking, never body copy. */
const ANNOTATION = "font-mono text-caption text-graphite";

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string; testId?: string }) {
  return (
    <label className="block" title={props.hint}>
      <span className="flex items-baseline justify-between text-body-sm">
        <span>{props.label}</span>
        <span className={`${ANNOTATION} tabular-nums`}>{round(props.value, 3)}</span>
      </span>
      <input
        type="range"
        data-testid={props.testId}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="mt-1 w-full"
      />
      {props.hint && <span className="block text-body-sm text-graphite">{props.hint}</span>}
    </label>
  );
}

function Section({ n, title, action, children }: { n: number; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t border-mist px-6 py-8">
      <h2 className="flex items-baseline gap-3 text-heading font-[340]">
        <span className={ANNOTATION}>{String(n).padStart(2, "0")}</span>
        {title}
        {action && <span className="ml-auto">{action}</span>}
      </h2>
      {children}
    </section>
  );
}

/** Text-only inline action (Surprise me, Reset): underlined ink, no fill. */
function TextAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-body-sm font-normal underline decoration-mist underline-offset-4 hover:decoration-ink">
      {children}
    </button>
  );
}

/** Chip: 50px pill. Selected inverts to solid ink. */
function Choice<T extends string>(props: { value: T; current: T; onSelect: (v: T) => void; children: ReactNode; title?: string }) {
  const on = props.value === props.current;
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={on}
      onClick={() => props.onSelect(props.value)}
      className={`rounded-pill border px-4 py-2 text-body-sm transition-colors ${on ? "border-ink bg-ink text-paper" : "border-mist bg-paper hover:border-ink"}`}
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
    <div className="fixed inset-0 flex flex-col bg-paper text-body-sm text-ink">
      <SiteNav current="studio" />
      <div className={`grid min-h-0 flex-1 ${menuOpen ? "grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1"}`}>
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
            onBuild={(ms, size) => setStatus(`${size.width}×${size.height} map · ${Math.round(ms)} ms`)}
            onError={(err) => setStatus(`Couldn't render: ${err.message}`)}
            style={{ width: `${stage.width}%`, maxHeight: "86%" }}
          />
          <button type="button" onClick={() => setMenuOpen((o) => !o)} className={`absolute right-6 top-4 bg-paper ${GHOST}`}>
            {menuOpen ? "Hide panel" : "Show panel"}
          </button>
          <p data-testid="status" className={`absolute bottom-6 left-6 ${ANNOTATION}`}>
            {fileName} · {status}
          </p>
          <p className="pointer-events-none absolute bottom-6 right-6 text-body-sm text-graphite">
            {settings.mode === "colour" && !settings.pick ? "Click the picture to choose the foil colour" : "Move to steer the light · drag to tilt"}
          </p>
          {dragging && (
            <div className="pointer-events-none absolute inset-6 grid place-items-center rounded-card border border-dashed border-ink bg-paper/90 text-heading font-[340]">
              Drop your picture
            </div>
          )}
        </div>

        {menuOpen && (
          <aside className="overflow-y-auto overscroll-contain border-l border-mist bg-paper">
            <header className="px-6 pb-2 pt-8">
              <h1 className="text-heading-lg font-[320]">Foil studio</h1>
              <p className="mt-3 text-body text-graphite">Turn an illustration into hot-foil stamping that catches the cursor&apos;s light.</p>
            </header>
            {error && (
              // Sticky, so errors from any section stay visible. Achromatic by design: ink on mist.
              <div role="alert" className="sticky top-0 z-10 mx-6 mt-4 flex items-start gap-3 rounded-control bg-mist px-4 py-3 text-body-sm">
                <span className="flex-1">{error}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="leading-none">
                  ×
                </button>
              </div>
            )}

            <Section n={1} title="Your picture">
              <button type="button" onClick={() => fileInput.current?.click()} className={`w-full ${GHOST}`}>
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
              <p className="text-body-sm text-graphite">Or drop or paste one. It stays in your browser.</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className={ANNOTATION}>SAMPLES</span>
                {SAMPLES.map((s) => (
                  <TextAction
                    key={s.src}
                    onClick={() => {
                      setSrc(s.src);
                      setFileName(s.name);
                      setError(null);
                    }}
                  >
                    {s.name}
                  </TextAction>
                ))}
              </div>
              <div className={ANNOTATION}>SHAPE</div>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(SHAPES) as ShapeKey[]).map((k) => (
                  <Choice key={k} value={k} current={settings.shape} onSelect={(shape) => set({ shape })}>
                    {SHAPES[k].name}
                  </Choice>
                ))}
              </div>
            </Section>

            <Section n={2} title="What turns to foil" action={<TextAction onClick={surprise}>Surprise me</TextAction>}>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(FOIL_MODES) as FoilMode[]).map((k) => (
                  <Choice key={k} value={k} current={settings.mode} onSelect={setMode} title={FOIL_MODES[k].hint}>
                    {FOIL_MODES[k].name}
                  </Choice>
                ))}
              </div>
              <p className="text-body-sm text-graphite">{mode.hint}</p>
              {settings.mode === "colour" && (
                <div className="flex items-center gap-3">
                  <span
                    data-testid="pick-swatch"
                    className="h-6 w-6 rounded-fine border border-mist"
                    style={{ background: settings.pick ? rgbCss(settings.pick) : "repeating-linear-gradient(45deg,#e2e2e2 0 4px,#fff 4px 8px)" }}
                  />
                  <span className={settings.pick ? ANNOTATION : "text-body-sm text-graphite"}>{settings.pick ? rgbCss(settings.pick) : "No colour picked yet"}</span>
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
              <label className="flex items-center gap-3">
                <input type="checkbox" className="h-4 w-4 accent-ink" checked={settings.border} onChange={(e) => set({ border: e.target.checked })} />
                A foil border round the edge
              </label>
            </Section>

            <Section n={3} title="Foil colour">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(FOILS) as FoilKey[]).map((k) => {
                  const f = FOILS[k];
                  const on = settings.foil === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      title={f.name}
                      aria-pressed={on}
                      onClick={() => set({ foil: k })}
                      className={`flex items-center gap-2 rounded-pill border px-4 py-2 text-body-sm transition-colors ${on ? "border-ink" : "border-mist hover:border-ink"}`}
                    >
                      {/* The swatch is the work's colour, not UI colour. */}
                      <span className="h-3.5 w-3.5 rounded-full" style={{ background: "holo" in f ? "conic-gradient(#ffc9c1, #c4baff, #c7f8fb, #e4ff97, #ffc9c1)" : rgbCss(f.ink) }} />
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
              <div className={ANNOTATION}>OR REPAINT AS PAPER</div>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(PAPERS) as PaperKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    title={PAPERS[k].name}
                    aria-label={PAPERS[k].name}
                    aria-pressed={settings.ground === k}
                    onClick={() => set({ ground: k })}
                    className={`h-8 w-8 rounded-full border ${settings.ground === k ? "border-ink ring-2 ring-ink ring-offset-2" : "border-mist"}`}
                    style={{ background: rgbCss(PAPERS[k].rgb) }}
                  />
                ))}
              </div>
              <p className="text-body-sm text-graphite">Works when the picture sits on a plain, light background.</p>
            </Section>

            <Section n={5} title="Finish" action={<TextAction onClick={() => set({ look: DEFAULT_LOOK, softness: DEFAULT_SETTINGS.softness })}>Reset</TextAction>}>
              <Slider testId="relief" label="Relief" value={settings.look.relief} min={0} max={8} step={0.1} onChange={(v) => setLook({ relief: v })} hint="How deep the stamp presses." />
              <Slider testId="softness" label="Softness" value={settings.softness} min={0} max={8} step={1} onChange={(v) => set({ softness: v })} hint="Rounder, puffier edges." />
              <Slider testId="crinkle" label="Crinkle" value={settings.look.crinkle} min={0} max={1} step={0.01} onChange={(v) => setLook({ crinkle: v })} hint="Fine texture in the metal." />
              <Slider testId="shine" label="Shine" value={settings.look.shine} min={0} max={3} step={0.05} onChange={(v) => setLook({ shine: v })} hint="Strength of the white-hot flash." />
              <Slider testId="lamp" label="Lamp height" value={settings.look.lampHeight} min={0.05} max={0.8} step={0.01} onChange={(v) => setLook({ lampHeight: v })} hint="Low is a tight torch, high a broad wash." />
              <Slider testId="grain" label="Paper grain" value={settings.look.grain} min={0} max={3} step={0.05} onChange={(v) => setLook({ grain: v })} />
            </Section>

            <Section n={6} title="Stage">
              <label className="flex items-center gap-3">
                <input type="color" className="h-8 w-10 rounded-control border border-mist" value={stage.background} onChange={(e) => setStage((s) => ({ ...s, background: e.target.value }))} />
                Preview background
              </label>
              <Slider label="Size %" value={stage.width} min={20} max={100} step={1} onChange={(width) => setStage((s) => ({ ...s, width }))} />
            </Section>

            <Section n={7} title="Use it">
              <div className="flex flex-wrap gap-2">
                <Choice value={"baked" as const} current={output} onSelect={setOutput} title="Ship the two processed maps. Nothing is computed on the visitor's device.">
                  Baked · fastest
                </Choice>
                <Choice value={"live" as const} current={output} onSelect={setOutput} title="Ship the original picture. Maps are computed in the browser on load.">
                  Live
                </Choice>
              </div>
              {output === "baked" && (
                <button type="button" onClick={downloadBaked} className={`w-full ${GHOST}`}>
                  Download the two maps
                </button>
              )}
              <pre data-testid="snippet" className="overflow-x-auto whitespace-pre-wrap rounded-control bg-mist/50 p-4 font-mono text-caption leading-relaxed text-ink">
                {code}
              </pre>
              {/* The one indigo element in the view: the main thing to do here. */}
              <button type="button" onClick={copyCode} className="w-full rounded-pill bg-indigo px-5 py-2.5 text-body-sm font-[480] text-paper hover:opacity-90">
                {copied === "jsx" ? "Copied" : "Copy JSX"}
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={savePng} className={GHOST}>
                  Save PNG
                </button>
                <button type="button" onClick={exportJson} className={GHOST}>
                  Export settings
                </button>
                <button type="button" onClick={() => importInput.current?.click()} className={GHOST}>
                  Import settings
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSettings(DEFAULT_SETTINGS);
                    setStage(DEFAULT_STAGE);
                  }}
                  className={GHOST}
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
              <p className="text-body-sm text-graphite">
                {output === "baked"
                  ? `Put ${baseName}-print.png and ${baseName}-fx.png in /public, then paste the JSX. Download again after changing anything above Finish.`
                  : "Put the picture in /public under the same name, then paste the JSX."}
              </p>
            </Section>
          </aside>
        )}
      </div>
    </div>
  );
}
