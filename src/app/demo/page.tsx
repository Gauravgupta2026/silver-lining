import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SiteNav } from "@/components/SiteNav";
import { FoilArt } from "@/components/foil/FoilArt";

export const metadata: Metadata = {
  title: "Demo — Silver Lining",
};

/** Grid card: soft surface, 16px radius, no shadow (elevation is reserved for the hero card). */
function Card({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <figure className="m-0">
      <div className="rounded-card bg-mist/40 p-6">{children}</div>
      <figcaption className="mt-4">
        <div className="text-body font-[520]">{title}</div>
        <div className="font-mono text-caption text-graphite">{note}</div>
      </figcaption>
    </figure>
  );
}

export default function DemoPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <SiteNav current="demo" />

      <main className="mx-auto max-w-[1200px] px-6">
        {/* Hero: the headline whispers, the foil does the talking. */}
        <section className="grid items-center gap-16 py-20 md:grid-cols-[1fr_440px] md:py-[120px]">
          <div>
            <p className="font-mono text-caption uppercase text-graphite">Hot-foil stamping for the web</p>
            <h1 className="mt-6 text-[44px] font-[320] leading-[1.1] tracking-[-0.02em] md:text-display">Light that follows the cursor.</h1>
            <p className="mt-6 max-w-[520px] text-body text-graphite">
              Drop in an illustration and its strokes turn to foil. Move the mouse and a lamp sweeps across them, flashing where the metal faces it.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link href="/" className="rounded-pill bg-indigo px-5 py-2.5 text-body-sm font-[480] text-paper hover:opacity-90">
                Open the studio
              </Link>
              <a href="#finishes" className="rounded-control border border-ink px-[18px] py-2 text-body-sm transition-colors hover:bg-ink hover:text-paper">
                See the finishes
              </a>
            </div>
          </div>
          <div className="rounded-card bg-paper p-6 shadow-float">
            <FoilArt src="/foil/umbrella-print.png" fx="/foil/umbrella-fx.png" alt="A blue parasol with tassels, its outlines in rose gold foil" settings={{ foil: "rose" }} className="mx-auto w-full max-w-[360px]" />
          </div>
        </section>

        <section id="finishes" className="py-20 md:py-[120px]">
          <h2 className="max-w-[720px] text-[40px] font-[320] leading-[1.1] tracking-[-0.015em] md:text-heading-lg">Same picture, different metal.</h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <Card title="Rose gold, live" note="umbrella.png · maps built in the browser">
              <FoilArt src="/foil/umbrella.png" alt="Parasol in rose gold foil, processed live" settings={{ foil: "rose" }} className="mx-auto w-full max-w-[320px]" />
            </Card>
            <Card title="Rose gold, baked" note="print + fx maps · no processing">
              <FoilArt src="/foil/umbrella-print.png" fx="/foil/umbrella-fx.png" alt="Parasol in rose gold foil, from baked maps" settings={{ foil: "rose" }} className="mx-auto w-full max-w-[320px]" />
            </Card>
            <Card title="Gold on line art" note='demo.svg · mode "all"'>
              <FoilArt src="/foil/demo.svg" alt="Gaurav with a sun and waves in gold foil" settings={{ mode: "all" }} className="w-full" />
            </Card>
            <Card title="Holographic" note='demo.svg · foil "holo"'>
              <FoilArt src="/foil/demo.svg" alt="The same line art in holographic foil" settings={{ mode: "all", foil: "holo" }} className="w-full" />
            </Card>
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-[1200px] px-6 pb-16 font-mono text-caption text-graphite">Silver Lining · WebGL, no dependencies · after bubbbly.com/foil-studio</footer>
    </div>
  );
}
