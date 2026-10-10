import Link from "next/link";

const NAV_HEIGHT_PX = 64;

/** Flat 64px top bar: mark left, pages right. No border or shadow; it sits on the white canvas. */
export function SiteNav({ current }: { current: "studio" | "demo" }) {
  const item = (href: string, label: string, key: typeof current) => (
    <Link
      href={href}
      aria-current={current === key ? "page" : undefined}
      className={`rounded-control px-3 py-1.5 text-body-sm ${current === key ? "border border-ink" : "border border-transparent text-graphite hover:text-ink"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="flex shrink-0 items-center justify-between bg-paper px-4 sm:px-6" style={{ height: NAV_HEIGHT_PX }}>
      <Link href="/" className="flex items-center gap-2 text-body-sm font-[520] tracking-tight">
        {/* Foil-ish mark: a thin conic ring, the system's decorative accent. */}
        <span aria-hidden className="h-5 w-5 rounded-full bg-[conic-gradient(#33dfdf,#b98e01,#33dfdf00_70%,#33dfdf)] p-[2px]">
          <span className="block h-full w-full rounded-full bg-paper" />
        </span>
        Silver Lining
      </Link>
      <div className="flex items-center gap-2">
        {item("/", "Studio", "studio")}
        {item("/demo", "Demo", "demo")}
      </div>
    </nav>
  );
}
