"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SiteNav } from "@/components/SiteNav";
import { forgetImage } from "@/components/imageCache";
import { ANNOTATION, Choice, GHOST, PanelTabs, PanelToggle, Section, Slider, TextAction } from "@/components/studio/controls";
import { VideoExport } from "@/components/studio/VideoExport";
import { LanternArt, type LanternHandle } from "./LanternArt";
import {
  DEFAULT_LANTERN_SETTINGS,
  FRAMES,
  LANTERN_LOOKS,
  NUMERIC_RANGES,
  resolveLanternSettings,
  TOGGLES,
  TURN_MODES,
  type FrameKey,
  type LanternLookKey,
  type LanternSettings,
  type Toggle,
  type TurnMode,
} from "./lanternSettings";

interface Stage {
  background: string;
  /** Preview width, percent of the stage. */
  width: number;
}

interface Saved {
  settings: LanternSettings;
  stage: Stage;
}

const STORAGE_KEY = "lantern-studio:v1";
/** Wall pictures that ship with the site. */
const DRAGON_WALL = { src: "/lantern/wall-dragon.jpg", name: "wall-dragon.jpg" } as const;
type Backdrop = { src: string; name: string };
const DEFAULT_STAGE: Stage = { background: "#fafafa", width: 60 };
const COPIED_MS = 1500;
const PANEL_GROUPS = [
  { key: "light", label: "Light" },
  { key: "glass", label: "Glass" },
  { key: "scene", label: "Scene" },
  { key: "export", label: "Export" },
] as const;
type PanelGroup = (typeof PANEL_GROUPS)[number]["key"];

/** Art never takes more than this share of the stage height, in container-query units. */
const ART_MAX_HEIGHT_CQH = 86;

const round = (v: number, places: number) => Number(v.toFixed(places));
type NumericKey = keyof typeof NUMERIC_RANGES;
const keysOf = <T extends object>(o: T) => Object.keys(o) as (keyof T)[];

/** JSX for the site, listing only values that differ from the defaults. */
function snippet(s: LanternSettings, backdrop: string | null): string {
  const diff = keysOf(DEFAULT_LANTERN_SETTINGS)
    .filter((k) => s[k] !== DEFAULT_LANTERN_SETTINGS[k])
    .map((k) => `${k}: ${typeof s[k] === "number" ? round(s[k] as number, 3) : JSON.stringify(s[k])}`);
  const props = [
    diff.length ? `\n  settings={{ ${diff.join(", ")} }}` : "",
    backdrop ? `\n  backdropSrc="${backdrop}"` : "",
  ].join("");
  return `<LanternArt${props}\n/>`;
}

/** Tune the sun, the glass and the motion, then copy the props for the site. Settings persist locally. */
export function LanternStudio() {
  const [settings, setSettings] = useState<LanternSettings>(DEFAULT_LANTERN_SETTINGS);
  const [stage, setStage] = useState<Stage>(DEFAULT_STAGE);
  const [backdrop, setBackdrop] = useState<Backdrop | null>(DRAGON_WALL);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Loading…");
  const [menuOpen, setMenuOpen] = useState(true);
  const [panelGroup, setPanelGroup] = useState<PanelGroup>("light");
  const [hydrated, setHydrated] = useState(false);
  const panelContent = useRef<HTMLDivElement>(null);
  const handle = useRef<LanternHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  // Restore after mount so server and client render the same first frame.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Saved> | null;
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from storage
        setSettings(resolveLanternSettings(saved.settings));
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

  // Free the previous object URL when the backdrop changes.
  useEffect(
    () => () => {
      if (backdrop?.src.startsWith("blob:")) {
        URL.revokeObjectURL(backdrop.src);
        forgetImage(backdrop.src);
      }
    },
    [backdrop],
  );

  const set = useCallback((patch: Partial<LanternSettings>) => setSettings((s) => resolveLanternSettings({ ...s, ...patch })), []);
  const slide = (key: NumericKey, label: string, hint?: string) => (
    <Slider testId={key} label={label} hint={hint} value={settings[key]} {...NUMERIC_RANGES[key]} onChange={(v) => set({ [key]: v })} />
  );

  const loadBackdrop = useCallback((file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(`“${file.name}” isn't an image. Try a PNG, JPG or WebP.`);
      return;
    }
    setError(null);
    setBackdrop({ src: URL.createObjectURL(file), name: file.name });
  }, []);

  // Samples live in /public/lantern; an upload is assumed to be copied to the /public root.
  const code = snippet(settings, backdrop ? (backdrop.src.startsWith("blob:") ? `/${backdrop.name}` : backdrop.src) : null);
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
    download(handle.current.snapshot(), "sun-lantern.png");
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    download(url, "sun-lantern.json");
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      setSettings(resolveLanternSettings(JSON.parse(await file.text())));
      setError(null);
    } catch {
      setError(`“${file.name}” isn't a valid settings file.`);
    }
  };

  const selectGroup = (key: PanelGroup) => {
    setPanelGroup(key);
    if (panelContent.current) panelContent.current.scrollTop = 0;
  };

  const frameAspect = FRAMES[settings.frame].aspect;

  return (
    <div className="app-shell studio-shell text-body">
      <main className={`studio-workspace ${menuOpen ? "" : "panel-hidden"}`}>
        <div className="studio-stage" style={{ background: stage.background }}>
          <SiteNav />
          <div className="stage-artwork">
            <LanternArt
              key={backdrop?.src ?? "plain"}
              settings={settings}
              backdropSrc={backdrop?.src}
              onReady={(h) => {
                handle.current = h;
                setStatus("Live");
              }}
              onError={(err) => {
                handle.current = null;
                setStatus(err.message === "WebGL is not available" ? "Static preview · WebGL2 unavailable" : "Preview unavailable");
              }}
              // Fit inside the stage on both axes: the width share, capped so the height never exceeds ART_MAX_HEIGHT.
              style={{ width: `min(${stage.width}cqw, ${ART_MAX_HEIGHT_CQH * frameAspect}cqh)` }}
            />
            <PanelToggle expanded={menuOpen} onToggle={() => setMenuOpen((open) => !open)} className="stage-toggle" />
          </div>
          <div className="stage-footer">
            <p data-testid="status" role="status" className="stage-status" title={status}>
              <span>{backdrop?.name ?? "Sun lantern"}</span>
              <span>{status}</span>
            </p>
            <p className="stage-instruction">Drag the glass to spin it</p>
          </div>
        </div>

        {menuOpen && (
          <aside id="studio-panel" aria-label="Lantern controls" className="studio-panel">
            <header className="studio-panel-header">
              <div className="studio-panel-title-row">
                <h1 className="studio-title">Sun lantern studio</h1>
                <PanelToggle expanded={menuOpen} onToggle={() => setMenuOpen(false)} className="panel-close" />
              </div>
              <p className="studio-description">A sun inside fluted glass.</p>
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

              <div id="group-light" role="tabpanel" aria-labelledby="group-tab-light" hidden={panelGroup !== "light"}>
                <Section title="Motion">
                  <div className={ANNOTATION}>What turns</div>
                  <div className="choice-grid choice-grid-3">
                    {keysOf(TURN_MODES).map((k) => (
                      <Choice key={k} value={k} current={settings.turns} onSelect={(turns: TurnMode) => set({ turns })} title={TURN_MODES[k].hint}>
                        {TURN_MODES[k].name}
                      </Choice>
                    ))}
                  </div>
                  <p className="text-body text-stone">{TURN_MODES[settings.turns].hint}</p>
                  {settings.turns !== "sun" && slide("glassSpeed", "Glass rpm", "Turns per minute. Negative turns the other way.")}
                  {settings.turns !== "glass" && (
                    <>
                      {slide("sunSpeed", "Sun rpm", "Orbit speed, in turns per minute.")}
                      {slide("sunOrbit", "Orbit", "How far from the middle the sun travels.")}
                    </>
                  )}
                </Section>

                <Section title="Sun">
                  {slide("sunSize", "Size", "Radius of the sun, as a share of the glass radius.")}
                  {slide("sunBrightness", "Brightness")}
                  {slide("rays", "Rays", "Streaks that fan out of the sun.")}
                  {slide("flicker", "Flicker", "Slow changes in brightness, like a flame.")}
                  {slide("bloom", "Bloom", "Glow that spills round bright areas.")}
                </Section>
              </div>

              <div id="group-glass" role="tabpanel" aria-labelledby="group-tab-glass" hidden={panelGroup !== "glass"}>
                <Section title="Flutes" action={<TextAction onClick={() => set({ flutes: DEFAULT_LANTERN_SETTINGS.flutes, depth: DEFAULT_LANTERN_SETTINGS.depth })}>Reset</TextAction>}>
                  {slide("flutes", "Flutes", "Ridges round the whole ring.")}
                  {slide("depth", "Depth °", "Steepest slope of a ridge. Steeper bends light more. Around 14–24° throws the sharpest lines on the wall.")}
                </Section>
                <Section title="Rod layer">
                  <div className="choice-grid">
                    {keysOf(TOGGLES).map((k) => (
                      <Choice key={k} value={k} current={settings.rodLayer} onSelect={(rodLayer: Toggle) => set({ rodLayer })}>
                        {TOGGLES[k].name}
                      </Choice>
                    ))}
                  </div>
                  <p className="text-body text-stone">A second ring of glass rods inside the first. It turns against the ring, so the two ribbed layers make waves of light.</p>
                  {settings.rodLayer === "on" && (
                    <>
                      {slide("rods", "Rods", "Rods round the inner layer. A different count from the flutes gives wider waves.")}
                      {slide("rodDepth", "Rod depth °", "Steepest slope of a rod.")}
                      {slide("rodSpin", "Rod speed ×", "Inner layer speed, as a multiple of the ring. Negative turns the other way.")}
                      {slide("wave", "Wave", "How far the rods bend sideways as they rise. This makes crests and valleys.")}
                    </>
                  )}
                </Section>
                <Section title="Material">
                  {slide("glassIndex", "Index", "Refractive index. Window glass is 1.52.")}
                  {slide("dispersion", "Colour split", "How far red and blue bend apart.")}
                  {slide("frost", "Frost", "Softens the image of the sun.")}
                  {slide("thickness", "Thickness", "Wall thickness, as a share of the radius.")}
                </Section>
              </div>

              <div id="group-scene" role="tabpanel" aria-labelledby="group-tab-scene" hidden={panelGroup !== "scene"}>
                <Section title="Look">
                  <div className="choice-grid">
                    {keysOf(LANTERN_LOOKS).map((k) => (
                      <Choice key={k} value={k} current={settings.look} onSelect={(look: LanternLookKey) => set({ look })} title={LANTERN_LOOKS[k].hint}>
                        {LANTERN_LOOKS[k].name}
                      </Choice>
                    ))}
                  </div>
                  <p className="text-body text-stone">{LANTERN_LOOKS[settings.look].hint}</p>
                </Section>

                <Section title="Lantern body">
                  {slide("ornament", "Gold detail", "Gold line art on the lacquer: key fret, lotus medallions, cloud scrolls, beaded rings.")}
                </Section>

                <Section title="Wall">
                  {slide("wallDistance", "Distance", "How far the wall is behind the lantern.")}
                  {slide("caustics", "Light on wall", "Strength of the light patterns thrown on the wall.")}
                  <div className="choice-grid">
                    <Choice value="dragon" current={backdrop?.src === DRAGON_WALL.src ? "dragon" : "other"} onSelect={() => setBackdrop(DRAGON_WALL)}>
                      Dragon silk
                    </Choice>
                    <Choice value="plain" current={backdrop === null ? "plain" : "other"} onSelect={() => setBackdrop(null)}>
                      Plain silk
                    </Choice>
                  </div>
                  <button type="button" onClick={() => fileInput.current?.click()} className="ui-button ui-button-secondary">
                    {backdrop && backdrop.src.startsWith("blob:") ? "Change wall picture" : "Upload a wall picture"}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      loadBackdrop(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <p className="text-body text-stone">The picture is lit by the sun and seen through the glass.</p>
                </Section>

                <Section title="Picture">
                  <div className={ANNOTATION}>Frame</div>
                  <div className="choice-grid choice-grid-3">
                    {keysOf(FRAMES).map((k) => (
                      <Choice key={k} value={k} current={settings.frame} onSelect={(frame: FrameKey) => set({ frame })}>
                        {FRAMES[k].name}
                      </Choice>
                    ))}
                  </div>
                  {slide("exposure", "Exposure")}
                  {slide("grain", "Grain", "Film noise. It also hides banding in dark areas.")}
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
                  <VideoExport getCanvas={() => handle.current?.canvas() ?? null} fileName={"sun-lantern"} onError={setError} />
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
                        setSettings(DEFAULT_LANTERN_SETTINGS);
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
                  <p className="text-body text-stone">If you use a wall picture, put it in /public, then paste the JSX. The lantern is drawn live in the visitor&apos;s browser.</p>
                </Section>
              </div>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
