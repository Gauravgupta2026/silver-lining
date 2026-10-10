import Link from "next/link";

export function SiteNav({ current }: { current: "studio" | "demo" }) {
  return (
    <nav aria-label="Main navigation" className="site-nav">
      <Link href="/" className="site-brand">
        <span aria-hidden="true" className="dot-mark">
          {Array.from({ length: 9 }, (_, i) => <span key={i} />)}
        </span>
        Silver Lining
      </Link>
      <div className="site-links">
        <Link href="/" aria-current={current === "studio" ? "page" : undefined}>Studio</Link>
        <Link href="/demo" aria-current={current === "demo" ? "page" : undefined}>Demo</Link>
      </div>
    </nav>
  );
}
