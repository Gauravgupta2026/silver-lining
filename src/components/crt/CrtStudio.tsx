"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { SiteNav } from "@/components/SiteNav";
import { forgetImage } from "@/components/imageCache";
import { ANNOTATION, Choice, GHOST, PanelTabs, PanelToggle, Section, Slider, TextAction } from "@/components/studio/controls";
import { CrtArt, type CrtHandle } from "./CrtArt";
import {
  CRT_LOOKS,
  CRT_PRESETS,
  DEFAULT_CRT_SETTINGS,
  GLYPH_SETS,
  INVERT_MODES,
  MASKS,
  NUMERIC_RANGES,
  resolveCrtSettings,
  type CrtLookKey,
  type CrtSettings,
  type GlyphSetKey,
  type InvertMode,
  type MaskKey,
} from "./crtSettings";

interface Stage {
  background: string;
  /** Preview width, percent of the stage. */
  width: number;
}

interface Saved {
  settings: CrtSettings;
  stage: Stage;
}

const STORAGE_KEY = "crt-studio:v1";
const SAMPLES = [
  { src: "/foil/umbrella.png", name: "umbrella.png", label: "Parasol" },
  { src: "/foil/demo.svg", name: "demo.svg", label: "Line art" },
] as const;
const DEFAULT_STAGE: Stage = { background: "#fafafa", width: 60 };
const COPIED_MS = 1500;
const PANEL_GROUPS = [
  { key: "look", label: "Look" },
  { key: "screen", label: "Screen" },
  { key: "export", label: "Export" },
] as const;
type PanelGroup = (typeof PANEL_GROUPS)[number]["key"];

/** Art never takes more than this share of the stage height, in container-query units. */
const ART_MAX_HEIGHT_CQH = 86;

const round = (v: number, places: number) => Number(v.toFixed(places));
type NumericKey = keyof typeof NUMERIC_RANGES;
const keysOf = <T extends object>(o: T) => Object.keys(o) as (keyof T)[];

/** JSX for the site, listing only values that differ from the defaults. */
function snippet(s: CrtSettings, path: string): string {
  const diff = keysOf(DEFAULT_CRT_SETTINGS)
    .filter((k) => s[k] !== DEFAULT_CRT_SETTINGS[k])
    .map((k) => `${k}: ${typeof s[k] === "number" ? round(s[k] as number, 3) : JSON.stringify(s[k])}`);
  const settings = diff.length ? `\n  settings={{ ${diff.join(", ")} }}` : "";
  return `<CrtArt\n  src="${path}"\n  alt=""${settings}\n/>`;
}

/** Drop an illustration, tune the screen, copy the props for the site. Settings persist locally. */
export function CrtStudio() {
  const [settings, setSettings] = useState<CrtSettings>(DEFAULT_CRT_SETTINGS);
  const [stage, setStage] = useState<Stage>(DEFAULT_STAGE);
  const [src, setSrc] = useState<string>(SAMPLES[0].src);
  const [fileName, setFileName] = useState<string>(SAMPLES[0].name);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Loading…");
  const [menuOpen, setMenuOpen] = useState(true);
  const [panelGroup, setPanelGroup] = useState<PanelGroup>("look");
  const [artAspect, setArtAspect] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  const panelContent = useRef<HTMLDivElement>(null);
  const handle = useRef<CrtHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  // Restore after mount so server and client render the same first frame.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Saved> | null;
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from storage
        setSettings(resolveCrtSettings(saved.settings));
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

  const set = useCallback((patch: Partial<CrtSettings>) => setSettings((s) => resolveCrtSettings({ ...s, ...patch })), []);
  const slide = (key: NumericKey, label: string, hint?: string) => (
    <Slider testId={key} label={label} hint={hint} value={settings[key]} {...NUMERIC_RANGES[key]} onChange={(v) => set({ [key]: v })} />
  );

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

  // Paste an image from the clipboard.
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

  const baseName = fileName.replace(/\.[^.]+$/, "");
  // Samples live in /public/foil; an upload is assumed to be copied to the /public root.
  const code = snippet(settings, src.startsWith("blob:") ? `/${fileName}` : src);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
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
    if (!handle.current) {
      setError("The live preview is not ready. Reload the page before saving a PNG.");
      return;
    }
    download(handle.current.snapshot(), `${baseName}-crt.png`);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    download(url, `${baseName}-crt.json`);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      setSettings(resolveCrtSettings(JSON.parse(await file.text())));
      setError(null);
    } catch {
      setError(`“${file.name}” isn't a valid settings file.`);
    }
  };

  const selectGroup = (key: PanelGroup) => {
    setPanelGroup(key);
    if (panelContent.current) panelContent.current.scrollTop = 0;
  };

  return (
    <div className="app-shell studio-shell text-body">
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
          <SiteNav />
          <div className="stage-artwork">
            <CrtArt
              key={src}
              src={src}
              alt={fileName}
              settings={settings}
              onReady={(h) => (handle.current = h)}
              onBuild={(size) => {
                setStatus("Preview ready");
                setArtAspect(size.width / size.height);
              }}
              onError={(err) => {
                handle.current = null;
                setStatus(err.message === "WebGL is not available" ? "Static preview · live screen unavailable" : "Preview unavailable");
              }}
              // Fit inside the stage on both axes: the width share, capped so the height never exceeds ART_MAX_HEIGHT.
              style={{ width: `min(${stage.width}cqw, ${ART_MAX_HEIGHT_CQH * artAspect}cqh)` }}
            />
            <PanelToggle expanded={menuOpen} onToggle={() => setMenuOpen((open) => !open)} className="stage-toggle" />
            {dragging && (
              <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-md border border-dashed border-obsidian bg-pure-white/90 text-heading font-[450]">
                Drop your picture
              </div>
            )}
          </div>
          <div className="stage-footer">
            <p data-testid="status" role="status" className="stage-status" title={`${fileName} · ${status}`}>
              <span>{fileName}</span>
              <span>{status}</span>
            </p>
            <p className="stage-instruction">Move the cursor over the glass</p>
          </div>
        </div>

        {menuOpen && (
          <aside id="studio-panel" aria-label="CRT controls" className="studio-panel">
            <header className="studio-panel-header">
              <div className="studio-panel-title-row">
                <h1 className="studio-title">CRT studio</h1>
                <PanelToggle expanded={menuOpen} onToggle={() => setMenuOpen(false)} className="panel-close" />
              </div>
              <p className="studio-description">Put your picture on an old screen.</p>
              <PanelTabs groups={PANEL_GROUPS} current={panelGroup} onSelect={selectGroup} />
            </header>
            <div ref={panelContent} className="studio-panel-content" role="region" aria-label="Studio settings" tabIndex={0}>
              {error && (
                // Keep errors visible while the controls scroll.
                <div role="alert" className="studio-alert">
                  <span className="flex-1">{error}</span>
                  <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="leading-none">
                    ×
                  </button>
                </div>
              )}

              <div id="group-look" role="tabpanel" aria-labelledby="group-tab-look" hidden={panelGroup !== "look"}>
                <Section title="Picture">
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
                        <Image src={sample.src} alt="" width={120} height={72} loading="eager" />
                        <span>{sample.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className={ANNOTATION}>Light and dark</div>
                  <div className="choice-grid choice-grid-3">
                    {keysOf(INVERT_MODES).map((k) => (
                      <Choice key={k} value={k} current={settings.invert} onSelect={(invert: InvertMode) => set({ invert })} title={INVERT_MODES[k].hint}>
                        {INVERT_MODES[k].name}
                      </Choice>
                    ))}
                  </div>
                  <p className="text-body text-stone">Auto makes pictures on a light page glow on a dark screen.</p>
                </Section>

                <Section title="Screen type" action={<TextAction onClick={() => set(CRT_PRESETS[settings.look].settings)}>Reset</TextAction>}>
                  <div className="choice-grid">
                    {keysOf(CRT_PRESETS).map((k) => (
                      <Choice key={k} value={k} current={settings.look} onSelect={(look: CrtLookKey) => set(CRT_PRESETS[look].settings)} title={CRT_PRESETS[k].hint}>
                        {CRT_PRESETS[k].name}
                      </Choice>
                    ))}
                  </div>
                  <p className="text-body text-stone">{CRT_LOOKS[settings.look].hint}</p>
                </Section>

                <Section title="Cells">
                  <div className={ANNOTATION}>Cell shape</div>
                  <div className="choice-grid choice-grid-3">
                    {keysOf(GLYPH_SETS).map((k) => (
                      <Choice key={k} value={k} current={settings.glyphs} onSelect={(glyphs: GlyphSetKey) => set({ glyphs })} title={GLYPH_SETS[k].hint}>
                        {GLYPH_SETS[k].name}
                      </Choice>
                    ))}
                  </div>
                  {slide("columns", "Cells across", "More cells, finer picture.")}
                  {slide("glyphMix", "Glyph shape", "From flat cells to full characters or dots.")}
                </Section>

                <Section title="Tone">
                  {slide("exposure", "Exposure", "How bright the picture is before the glow.")}
                  {slide("contrast", "Contrast", "Crushes shadows and blows out highlights.")}
                  {slide("bloom", "Bloom", "Glow that spills round bright areas.")}
                  {slide("focus", "Softness", "How much each cell leaks into its neighbours.")}
                </Section>
              </div>

              <div id="group-screen" role="tabpanel" aria-labelledby="group-tab-screen" hidden={panelGroup !== "screen"}>
                <Section title="Glass">
                  {slide("curve", "Curve", "How much the screen bulges.")}
                  {slide("bezel", "Bezel", "Width of the black frame.")}
                  {slide("aberration", "Colour split", "Red and blue drift apart toward the edges.")}
                </Section>

                <Section title="Phosphor mask">
                  <div className="choice-grid choice-grid-3">
                    {keysOf(MASKS).map((k) => (
                      <Choice key={k} value={k} current={settings.mask} onSelect={(mask: MaskKey) => set({ mask })} title={MASKS[k].hint}>
                        {MASKS[k].name}
                      </Choice>
                    ))}
                  </div>
                  {settings.mask !== "none" && (
                    <>
                      {slide("maskDensity", "Density", "Stripes or dots across the picture.")}
                      {slide("maskStrength", "Strength")}
                    </>
                  )}
                  {slide("scanlines", "Scan lines", "Dark gaps between lines of the picture.")}
                </Section>

                <Section title="Signal">
                  {slide("grain", "Grain", "Noise in the picture.")}
                  {slide("sparkle", "Specks", "Rare bright cells in dark areas.")}
                  {slide("flicker", "Flicker", "Small, fast changes in brightness.")}
                  {slide("roll", "Roll bar", "A slow bright band moving down the screen.")}
                  {slide("glitch", "Tears", "Rare horizontal tears.")}
                  {slide("lens", "Cursor lens", "How strongly the cursor bends the glass.")}
                </Section>

                <Section title="Preview">
                  <label className="flex items-center gap-3">
                    <input type="color" aria-label="Preview background" className="stage-color" value={stage.background} onChange={(e) => setStage((s) => ({ ...s, background: e.target.value }))} />
                    Preview background
                  </label>
                  <Slider label="Size %" value={stage.width} min={20} max={100} step={1} onChange={(width) => setStage((s) => ({ ...s, width }))} />
                </Section>
              </div>

              <div id="group-export" role="tabpanel" aria-labelledby="group-tab-export" hidden={panelGroup !== "export"}>
                <Section title="Export">
                  <pre data-testid="snippet" className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-paper-white p-4 font-mono text-caption leading-relaxed text-obsidian">
                    {code}
                  </pre>
                  {/* Primary export action. */}
                  <button type="button" onClick={copyCode} className="ui-button ui-button-primary">
                    {copied ? "Copied" : "Copy JSX"}
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
                        setSettings(DEFAULT_CRT_SETTINGS);
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
                  <p className="text-body text-stone">Put the picture in /public, then paste the JSX. The screen is drawn live in the visitor&apos;s browser.</p>
                </Section>
              </div>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
