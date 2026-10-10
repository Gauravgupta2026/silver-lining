import Link from "next/link";

export function SiteNav() {
  return (
    <Link href="/" className="site-brand">
      <svg aria-hidden="true" className="brand-mark" viewBox="0 0 24 24"><path d="M12 2 24 22H0Z" /></svg>
      Silver Lining
    </Link>
  );
}
