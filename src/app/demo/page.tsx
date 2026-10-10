import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { FoilArt } from "@/components/foil/FoilArt";
import type { FoilSettingsInput } from "@/components/foil/foilSettings";

export const metadata: Metadata = { title: "Demo — Silver Lining" };

const DEMO_MAX_HEIGHT_CQH = 85;

const FINISHES: { title: string; src: string; fx?: string; aspect: number; settings: FoilSettingsInput }[] = [
  { title: "Rose gold, live", src: "/foil/umbrella.png", aspect: 1142 / 1377, settings: { foil: "rose" } },
  { title: "Rose gold, baked", src: "/foil/umbrella-print.png", fx: "/foil/umbrella-fx.png", aspect: 1062 / 1280, settings: { foil: "rose" } },
  { title: "Gold on line art", src: "/foil/demo.svg", aspect: 1600 / 900, settings: { mode: "all" } },
  { title: "Holographic", src: "/foil/demo.svg", aspect: 1600 / 900, settings: { mode: "all", foil: "holo" } },
];

export default function DemoPage() {
  return (
    <div className="app-shell">
      <SiteNav />
      <main className="demo-main">
        <header className="demo-heading">
          <h1>Light that follows you.</h1>
          <p>One illustration. A different kind of shine. Move over a picture to catch the light.</p>
        </header>
        <section aria-label="Foil finishes" className="demo-gallery">
          {FINISHES.map((finish) => (
            <figure key={finish.title} className="demo-card">
              <div className="demo-art">
                <FoilArt src={finish.src} fx={finish.fx} alt={finish.title} settings={finish.settings} style={{ width: `min(90cqw, ${DEMO_MAX_HEIGHT_CQH * finish.aspect}cqh)` }} />
              </div>
              <figcaption>{finish.title}</figcaption>
            </figure>
          ))}
        </section>
        <div className="demo-actions">
          <Link href="/">Open the studio</Link>
          <a href="/foil/umbrella.png" download>Download sample</a>
        </div>
      </main>
      <footer className="demo-footer">Silver Lining · Hot-foil stamping for the web</footer>
    </div>
  );
}
