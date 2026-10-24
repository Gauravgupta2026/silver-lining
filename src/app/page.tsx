import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { CrtArt } from "@/components/crt/CrtArt";
import { FoilArt } from "@/components/foil/FoilArt";
import { LanternArt } from "@/components/lantern/LanternArt";

/** Both effects show the same picture, so the only difference is the finish. */
const SHOWCASE_SRC = "/foil/umbrella.png";
const SHOWCASE_ASPECT = 1142 / 1377;
/** Art never takes more than this share of its card's height, in container-query units. */
const ART_MAX_HEIGHT_CQH = 88;
const ART_WIDTH = `min(88cqw, ${ART_MAX_HEIGHT_CQH * SHOWCASE_ASPECT}cqh)`;
/** The lantern is its own picture, so it sizes itself from the portrait frame (3:4). */
const LANTERN_ART_WIDTH = `min(88cqw, ${ART_MAX_HEIGHT_CQH * (3 / 4)}cqh)`;

const NAV = [
  { href: "/foil", label: "Foil studio" },
  { href: "/crt", label: "CRT studio" },
  { href: "/lantern", label: "Sun lantern" },
  { href: "/demo", label: "Foil gallery" },
] as const;

export default function HomePage() {
  return (
    <div className="app-shell home-shell">
      <header className="home-header">
        <SiteNav />
        <nav aria-label="Studios" className="home-nav">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="home-main">
        <div className="home-hero">
          <h1>Make a picture catch the light.</h1>
          <p>Three effects for the web. Pick one, tune it in its studio, and copy the code.</p>
        </div>
        <section aria-label="Effects" className="home-effects">
          <Link href="/foil" className="home-card">
            <div className="home-art">
              <FoilArt src={SHOWCASE_SRC} alt="A parasol in rose-gold foil" settings={{ foil: "rose" }} style={{ width: ART_WIDTH }} />
            </div>
            <div className="home-card-body">
              <div>
                <span className="field-label">01 · Hot foil</span>
                <h2>Light that follows you</h2>
                <p>Metal that flashes where your cursor points the lamp.</p>
              </div>
              <span className="home-card-cta">Open studio →</span>
            </div>
          </Link>
          <Link href="/crt" className="home-card">
            <div className="home-art">
              <CrtArt src={SHOWCASE_SRC} alt="The same parasol on a blue CRT screen" style={{ width: ART_WIDTH }} />
            </div>
            <div className="home-card-body">
              <div>
                <span className="field-label">02 · CRT screen</span>
                <h2>An old tube, still glowing</h2>
                <p>Cells, phosphor stripes, bloom and grain on curved glass.</p>
              </div>
              <span className="home-card-cta">Open studio →</span>
            </div>
          </Link>
          <Link href="/lantern" className="home-card">
            <div className="home-art">
              <LanternArt alt="A glowing sun inside a fluted glass lantern" backdropSrc="/lantern/wall-dragon.jpg" style={{ width: LANTERN_ART_WIDTH }} />
            </div>
            <div className="home-card-body">
              <div>
                <span className="field-label">03 · Sun lantern</span>
                <h2>A sun behind ribbed glass</h2>
                <p>Light bends through fluted glass and spills on the wall.</p>
              </div>
              <span className="home-card-cta">Open studio →</span>
            </div>
          </Link>
        </section>
      </main>
      <footer className="demo-footer">Silver Lining · Picture effects for the web</footer>
    </div>
  );
}
