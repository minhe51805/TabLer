import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Download } from "lucide-react";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary } from "@/lib/i18n";
import { getDocHeadings, getDocs } from "@/lib/docs";
import { repositoryUrl } from "@/lib/site";
import { LanguageToggle } from "../LanguageToggle";
import { DocsSidebar } from "./DocsSidebar";

export default async function DocsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const language = await getSiteLanguage();
  const t = getDictionary(language);
  const docs = getDocs(language);

  const navItems = docs.pages.map((page) => ({
    slug: page.slug,
    icon: page.icon,
    title: page.title,
  }));

  const connectionsPage = docs.pages.find((page) => page.slug === "connections");
  const connectSubnav = connectionsPage
    ? getDocHeadings(connectionsPage)
        .headings.filter((heading) => heading.level === 3)
        .map((heading) => ({
          href: `/docs/connections#${heading.id}`,
          label: heading.text,
        }))
    : [];

  return (
    <main className="docs-page" id="main">
      <header className="site-header">
        <div className="shell header-inner">
          <Link className="brand" href="/" aria-label="TableR home">
            <Image
              src="/tabler-brand-mark.png"
              width={36}
              height={36}
              alt=""
              priority
            />
            <span>TableR</span>
          </Link>

          <nav className="main-nav" aria-label="Main navigation">
            <Link href="/#features">{t.nav.features}</Link>
            <Link href="/#workflow">{t.nav.workflow}</Link>
            <Link href="/#agent">{t.nav.agent}</Link>
            <Link href="/#engines">{t.nav.engines}</Link>
            <Link href="/changelog">{t.nav.changelog}</Link>
            <Link className="is-current" href="/docs" aria-current="page">
              {t.nav.docs}
            </Link>
          </nav>

          <div className="header-actions">
            <LanguageToggle current={language} />
            <a className="button button-small button-primary" href="/download">
              <Download size={16} aria-hidden="true" />
              {t.nav.download}
            </a>
          </div>
        </div>
      </header>

      <div className="shell docs-layout">
        <DocsSidebar
          items={navItems}
          groups={docs.groups}
          label={docs.label}
          menuLabel={docs.menu}
          connectSubnav={connectSubnav}
        />
        <div className="docs-main">{children}</div>
      </div>

      <footer>
        <div className="shell footer-inner">
          <Link className="brand footer-brand" href="/" aria-label="TableR home">
            <Image src="/tabler-brand-mark.png" width={30} height={30} alt="" />
            <span>TableR</span>
          </Link>
          <p>{t.footer.built}</p>
          <div className="footer-links">
            <a href={repositoryUrl} target="_blank" rel="noreferrer">
              {t.footer.github}
            </a>
            <a href="/download">{t.footer.download}</a>
            <Link href="/changelog">{t.footer.changelog}</Link>
            <Link href="/docs">{t.footer.docs}</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
