import type { Metadata } from "next";
import Link from "next/link";
import { FoilArt } from "@/components/foil/FoilArt";

export const metadata: Metadata = {
  title: "Demo — Silver Lining",
};

export default function DemoPage() {
  return (
    <main className="fixed inset-0 z-[200] flex flex-col items-center gap-10 overflow-auto bg-[#f4f1ea] px-6 py-16">
      <Link href="/" className="absolute right-5 top-5 text-sm text-[#6b665e] underline-offset-4 hover:underline">
        Open the studio
      </Link>
      <div className="flex w-full max-w-[900px] shrink-0 gap-8">
        {/* Live: maps computed in the browser from the original picture. */}
        <FoilArt src="/foil/umbrella.png" alt="A blue parasol with tassels" settings={{ foil: "rose" }} className="flex-1" />
        {/* Baked: the same look from maps exported by the studio. No processing on load. */}
        <FoilArt src="/foil/umbrella-print.png" fx="/foil/umbrella-fx.png" alt="" settings={{ foil: "rose" }} className="flex-1" />
      </div>
      <div className="flex w-full max-w-[1100px] shrink-0 gap-8">
        <FoilArt src="/foil/demo.svg" alt="" settings={{ mode: "all" }} className="flex-1" />
        <FoilArt src="/foil/demo.svg" alt="" settings={{ mode: "all", foil: "holo" }} className="flex-1" />
      </div>
    </main>
  );
}
