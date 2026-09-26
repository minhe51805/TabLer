import Image from "next/image";
import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { repositoryUrl } from "@/lib/site";

type FooterLink = { href: string; label: string; external?: boolean };

/**
 * Shared dark footer — light page on top, black band at the bottom.
 * Used by every page so the site ends consistently.
 */
export function SiteFooter({ t }: { t: Dictionary }) {
  const f = t.footer;
  const product: FooterLink[] = [
    { href: "/#features", label: t.nav.features },
    { href: "/#workflow", label: t.nav.workflow },
    { href: "/#agent", label: t.nav.agent },
    { href: "/#engines", label: t.nav.engines },
    { href: "/plugins", label: t.nav.plugins },
  ];
  const resources: FooterLink[] = [
    { href: "/docs", label: f.docs },
    { href: "/changelog", label: f.changelog },
    { href: "/download", label: f.download },
    { href: `${repositoryUrl}/releases`, label: f.releases, external: true },
  ];
  const community: FooterLink[] = [
    { href: repositoryUrl, label: f.github, external: true },
    { href: `${repositoryUrl}/issues`, label: f.issues, external: true },
    { href: "https://buymeacoffee.com/minjev", label: f.support, external: true },
  ];
  const columns = [
    { title: f.product, links: product },
    { title: f.resources, links: resources },
    { title: f.community, links: community },
  ];

  return (
    <footer className="site-footer">
      <div className="shell site-footer-grid">
        <div className="site-footer-brand">
          <Link className="brand footer-brand" href="/#top" aria-label="TableR home">
            <Image src="/tabler-brand-mark.png" width={30} height={30} alt="" />
            <span>TableR</span>
          </Link>
          <p>{f.tagline}</p>
        </div>
        {columns.map((col) => (
          <nav className="site-footer-col" key={col.title} aria-label={col.title}>
            <strong>{col.title}</strong>
            {col.links.map((link) =>
              link.external ? (
                <a href={link.href} key={link.href} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              ) : (
                <Link href={link.href} key={link.href} prefetch={false}>
                  {link.label}
                </Link>
              ),
            )}
          </nav>
        ))}
      </div>
      {/* giant wordmark — the reference sites' oversized footer type,
          clipped to the dark band so it reads as a watermark */}
      <div className="footer-wordmark" aria-hidden="true">
        TableR
      </div>
      <div className="shell site-footer-bottom">
        <span>{f.built}</span>
        <span>{f.license}</span>
      </div>
    </footer>
  );
}
