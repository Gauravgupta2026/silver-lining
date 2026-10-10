"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
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
  { src: "/foil/umbrella.png", name: "umbrella.png", label: "Parasol" },
  { src: "/foil/demo.svg", name: "demo.svg", label: "Line art" },
] as const;
const DEFAULT_STAGE: Stage = { background: "#f7f5f3", width: 60 };
const COPIED_MS = 1500;
const TABS = [
  { key: "picture", label: "Picture" },
  { key: "paper", label: "Paper" },
  { key: "foil", label: "Foil" },
  { key: "finish", label: "Finish" },
  { key: "export", label: "Export" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
/** Art never takes more than this share of the stage height, in container-query units. */
const ART_MAX_HEIGHT_CQH = 86;
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

/** All actions share the guide's radius and monochrome palette. */
const GHOST = "ui-button ui-button-secondary";
/** Muted supporting information uses the caption scale. */
const ANNOTATION = "text-caption text-stone";
/** Wrap choices so every option remains visible at narrow widths. */
const CHIPS = "choice-list";

/** One row per slider: label, track, value. Halves the panel height versus stacked rows. */
function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string; testId?: string }) {
  return (
    <label className="studio-slider" title={props.hint}>
      <span className="slider-label">{props.label}</span>
      <input
        type="range"
        data-testid={props.testId}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full"
      />
      <span className={`${ANNOTATION} text-right tabular-nums`}>{round(props.value, 2)}</span>
    </label>
  );
}

function Section({ title, action, children }: { n?: number; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="studio-section">
      <h2 className="flex items-baseline gap-2 text-body font-medium">
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
    <button type="button" onClick={onClick} className="text-action">
      {children}
    </button>
  );
}

/** Selected choices invert to ink; surfaces stay flat. */
function Choice<T extends string>(props: { value: T; current: T; onSelect: (v: T) => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={props.value === props.current}
      onClick={() => props.onSelect(props.value)}
      className="ui-choice"
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
  const [artAspect, setArtAspect] = useState(1);
  const [tab, setTab] = useState<TabKey>("picture");
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
    <div className="app-shell text-body">
      <SiteNav current="studio" />
      <main className={`studio-workspace ${menuOpen ? "" : "panel-hidden"}`}>
        <div
          className="studio-stage"
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
            onBuild={(ms, size) => {
              setStatus(`${size.width}×${size.height} map · ${Math.round(ms)} ms`);
              setArtAspect(size.width / size.height);
            }}
            onError={(err) => setStatus(`Couldn't render: ${err.message}`)}
            // Fit inside the stage on both axes: the width share, capped so the height never exceeds ART_MAX_HEIGHT.
            style={{ width: `min(${stage.width}cqw, ${ART_MAX_HEIGHT_CQH * artAspect}cqh)` }}
          />
          <button type="button" aria-expanded={menuOpen} aria-controls="studio-panel" onClick={() => setMenuOpen((o) => !o)} className={`stage-toggle ${GHOST}`}>
            {menuOpen ? "Hide panel" : "Show panel"}
          </button>
          <p data-testid="status" className={`stage-status ${ANNOTATION}`}>
            {fileName} · {status}
          </p>
          <p className="stage-instruction">
            {settings.mode === "colour" && !settings.pick ? "Click the picture to choose the foil colour" : "Move to steer the light · drag to tilt"}
          </p>
          {dragging && (
            <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border border-dashed border-ink-black bg-paper-white/90 text-heading font-[350]">
              Drop your picture
            </div>
          )}
        </div>

        {menuOpen && (
          <aside id="studio-panel" aria-label="Foil controls" className="studio-panel">
            <header className="studio-panel-header">
              <h1 className="studio-title">Foil studio</h1>
              <p className="studio-description">Edit your illustration, paper and foil.</p>
              {/* Tabs keep each group of controls within one screen, so the studio never becomes a long scroll. */}
              <div role="tablist" aria-label="Studio settings" className="studio-tabs">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    id={`tab-${t.key}`}
                    aria-controls="studio-tabpanel"
                    tabIndex={tab === t.key ? 0 : -1}
                    aria-selected={tab === t.key}
                    onKeyDown={(e) => {
                      const index = TABS.findIndex((item) => item.key === tab);
                      const next = e.key === "ArrowRight" ? (index + 1) % TABS.length : e.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
                      if (next !== null) {
                        e.preventDefault();
                        setTab(TABS[next].key);
                        document.getElementById(`tab-${TABS[next].key}`)?.focus();
                      }
                    }}
                    onClick={() => setTab(t.key)}
                    className={`flex-1 rounded-2xl px-1 py-1 text-body transition-colors ${tab === t.key ? "bg-ink-black text-paper-white" : "text-stone hover:text-ink-black"}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </header>
            <div key={tab} id="studio-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`tab-${tab}`} className="studio-panel-content">
            {error && (
              // Keep errors visible while the controls scroll.
              <div role="alert" className="sticky top-0 z-10 mx-4 mb-3 sm:mx-5 flex items-start gap-3 rounded-2xl bg-linen-canvas px-4 py-3 text-body">
                <span className="flex-1">{error}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="leading-none">
                  ×
                </button>
              </div>
            )}

            {tab === "picture" && (
              <>
            <Section n={1} title="Your picture">
              <button type="button" onClick={() => fileInput.current?.click()} className="ui-button ui-button-primary">
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
              <div className={ANNOTATION}>Samples</div>
              <div className="sample-picker">
                {SAMPLES.map((sample) => (
                  <button
                    key={sample.src}
                    type="button"
                    aria-pressed={src === sample.src}
                    className="sample-choice"
                    onClick={() => {
                      setSrc(sample.src);
                      setFileName(sample.name);
                      setError(null);
                    }}
                  >
                    <Image src={sample.src} alt="" width={120} height={72} />
                    <span>{sample.label}</span>
                  </button>
                ))}
              </div>
              <div className={ANNOTATION}>Shape</div>
              <div className="choice-grid">
                {(Object.keys(SHAPES) as ShapeKey[]).map((k) => (
                  <Choice key={k} value={k} current={settings.shape} onSelect={(shape) => set({ shape })}>
                    {SHAPES[k].name}
                  </Choice>
                ))}
              </div>
            </Section>

              </>
            )}
            {tab === "paper" && (
              <>
            <Section n={4} title="Background">
              <div className={CHIPS}>
                <Choice value={"transparent" as Ground} current={settings.ground} onSelect={(ground) => set({ ground })}>
                  Cut out
                </Choice>
                <Choice value={"keep" as Ground} current={settings.ground} onSelect={(ground) => set({ ground })}>
                  Keep
                </Choice>
              </div>
              <div className={ANNOTATION}>Paper stock</div>
              <div className={CHIPS}>
                {(Object.keys(PAPERS) as PaperKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    title={PAPERS[k].name}
                    aria-label={PAPERS[k].name}
                    aria-pressed={settings.ground === k}
                    onClick={() => set({ ground: k })}
                    className="paper-swatch"
                    style={{ background: rgbCss(PAPERS[k].rgb) }}
                  />
                ))}
              </div>
              <p className="text-body text-stone">Works when the picture sits on a plain, light background.</p>
            </Section>

              </>
            )}
            {tab === "foil" && (
              <>
            <Section n={2} title="Foil coverage" action={<TextAction onClick={surprise}>Surprise me</TextAction>}>
              <div className="choice-grid">
                {(Object.keys(FOIL_MODES) as FoilMode[]).map((k) => (
                  <Choice key={k} value={k} current={settings.mode} onSelect={setMode} title={FOIL_MODES[k].hint}>
                    {FOIL_MODES[k].name}
                  </Choice>
                ))}
              </div>
              <p className="text-body text-stone">{mode.hint}</p>
              {settings.mode === "colour" && (
                <div className="flex items-center gap-3">
                  <span
                    data-testid="pick-swatch"
                    className="h-6 w-6 rounded-2xl border border-ink-black/15"
                    style={{ background: settings.pick ? rgbCss(settings.pick) : "repeating-linear-gradient(45deg,#e2e2e2 0 4px,#fff 4px 8px)" }}
                  />
                  <span className={settings.pick ? ANNOTATION : "text-body text-stone"}>{settings.pick ? rgbCss(settings.pick) : "No colour picked yet"}</span>
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
              <label className="checkbox-control">
                <input type="checkbox" className="h-4 w-4 accent-ink-black" checked={settings.border} onChange={(e) => set({ border: e.target.checked })} />
                A foil border round the edge
              </label>
            </Section>

            <Section n={3} title="Foil colour">
              <div className="choice-grid">
                {(Object.keys(FOILS) as FoilKey[]).map((k) => {
                  const f = FOILS[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      title={f.name}
                      aria-pressed={settings.foil === k}
                      onClick={() => set({ foil: k })}
                      className="ui-choice foil-choice"
                    >
                      {/* The swatch is the work's colour, not UI colour. */}
                      <span className="h-3.5 w-3.5 rounded-full" style={{ background: "holo" in f ? "conic-gradient(#ffc9c1, #c4baff, #c7f8fb, #e4ff97, #ffc9c1)" : rgbCss(f.ink) }} />
                      {f.name}
                    </button>
                  );
                })}
              </div>
            </Section>

              </>
            )}
            {tab === "finish" && (
              <>
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
                <input type="color" aria-label="Preview background" className="stage-color" value={stage.background} onChange={(e) => setStage((s) => ({ ...s, background: e.target.value }))} />
                Preview background
              </label>
              <Slider label="Size %" value={stage.width} min={20} max={100} step={1} onChange={(width) => setStage((s) => ({ ...s, width }))} />
            </Section>

              </>
            )}
            {tab === "export" && (
              <>
            <Section n={7} title="Export">
              <div className="export-options">
                <Choice value={"baked" as const} current={output} onSelect={setOutput} title="Ship the two processed maps. Nothing is computed on the visitor's device.">
                  Baked · fastest
                </Choice>
                <Choice value={"live" as const} current={output} onSelect={setOutput} title="Ship the original picture. Maps are computed in the browser on load.">
                  Live
                </Choice>
                {output === "baked" && (
                  <button type="button" onClick={downloadBaked} className={`download-maps ${GHOST}`} title="Download the print and fx maps">
                    Download maps
                  </button>
                )}
              </div>
              <pre data-testid="snippet" className="max-h-28 overflow-auto [@media(max-height:700px)]:max-h-20 whitespace-pre-wrap rounded-2xl bg-linen-canvas p-4 font-mono text-caption leading-relaxed text-ink-black">
                {code}
              </pre>
              {/* Primary export action. */}
              <button type="button" onClick={copyCode} className="ui-button ui-button-primary">
                {copied === "jsx" ? "Copied" : "Copy JSX"}
              </button>
              <div className="export-actions">
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
              <p className="text-body text-stone [@media(max-height:700px)]:hidden" title="Download the maps again after changing anything outside Finish.">
                {output === "baked" ? "Put both maps in /public, then paste the JSX." : "Put the picture in /public, then paste the JSX."}
              </p>
            </Section>
              </>
            )}
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
