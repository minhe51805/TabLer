import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BookMarked,
  Bot,
  Check,
  Code2,
  Database,
  Download,
  Eye,
  GitBranch,
  GitFork,
  History,
  KeyRound,
  Layers3,
  LayoutGrid,
  Network,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { getTableRReleases } from "@/lib/github-releases";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary, type Dictionary } from "@/lib/i18n";
import { repositoryUrl } from "@/lib/site";
import { LanguageToggle } from "./LanguageToggle";
import { AgentDemo } from "./AgentDemo";
import {
  DockToggle,
  MobileNav,
  HeroScrollFX,
  ScrollReveal,
  TiltFrame,
  ScrollProgress,
  ScrollSpy,
  MagneticButtons,
  CursorGlow,
  HeadingReveal,
  WordStagger,
  BackToTop,
  SignalCounters,
  WorkflowProgress,
} from "./Home3D";
import { EngineMark } from "./engine-logos";
import { SiteFooter } from "./SiteFooter";

export const revalidate = 300;

const downloadUrl = "/download";

const featureIcons = [Database, Code2, Bot, Network];

const workflowMedia = [
  {
    icon: KeyRound,
    image: "/screenshots/table-r-connection-launcher.png",
    alt: "TableR connection launcher showing saved PostgreSQL connections",
    width: 1920,
    height: 1080,
  },
  {
    icon: Terminal,
    image: "/screenshots/table-r-query-workspace.png",
    alt: "TableR query workspace with SQL editor and result table",
    width: 1920,
    height: 1080,
  },
  {
    icon: Sparkles,
    image: "/screenshots/table-r-ai-workspace.png",
    alt: "TableR AI workspace beside the SQL editor",
    width: 1920,
    height: 1080,
  },
];

const agentIcons = [Eye, BookMarked, ShieldCheck, RefreshCw];

function navLinks(t: Dictionary) {
  return [
    { href: "#features", label: t.nav.features, icon: LayoutGrid },
    { href: "#workflow", label: t.nav.workflow, icon: Workflow },
    { href: "#agent", label: t.nav.agent, icon: Bot },
    { href: "#engines", label: t.nav.engines, icon: Database },
    { href: "#open-source", label: t.nav.openSource, icon: GitFork },
    { href: "/changelog", label: t.nav.changelog, icon: History },
    { href: "/docs", label: t.nav.docs, icon: BookMarked },
    { href: "/plugins", label: t.nav.plugins, icon: Puzzle },
  ];
}

const engines = [
  "PostgreSQL",
  "MySQL",
  "MariaDB",
  "SQLite",
  "DuckDB",
  "Cassandra",
  "CockroachDB",
  "Snowflake",
  "Greenplum",
  "Amazon Redshift",
  "SQL Server",
  "Redis",
  "MongoDB",
  "Vertica",
  "ClickHouse",
  "BigQuery",
  "LibSQL",
  "Cloudflare D1",
  "Oracle",
  "DynamoDB",
  "Elasticsearch",
  "OpenSearch",
  "Spanner",
  "Trino",
  "SurrealDB",
  "Weaviate",
];

const architectureIcons = [Layers3, Workflow, ShieldCheck, Code2, GitBranch, Zap];

export default async function Home() {
  const language = await getSiteLanguage();
  const t = getDictionary(language);
  const releases = await getTableRReleases();
  const latestVersion = releases[0]?.tag ?? "latest";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "TableR",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Windows, macOS, Linux",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    description:
      "Query, explore, visualize, and understand your databases from one focused open-source desktop workspace.",
    url: repositoryUrl,
    downloadUrl: `${repositoryUrl}/releases`,
    softwareVersion: latestVersion,
    license: "https://www.gnu.org/licenses/gpl-3.0.html",
  };

  return (
    <main id="main" className="neu">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ScrollReveal />
      <HeroScrollFX phases={t.hero.phases} />
      <div className="scroll-progress" aria-hidden="true" />
      <ScrollProgress />
      <ScrollSpy />
      <WorkflowProgress />
      <SignalCounters />
      <MagneticButtons />
      <CursorGlow />
      <HeadingReveal />
      <WordStagger />
      <BackToTop />
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="#top" aria-label="TableR home">
            <Image src="/tabler-brand-mark.png" width={36} height={36} alt="" priority />
            <span>TableR</span>
          </a>

          <nav className="main-nav" aria-label="Main navigation">
            {navLinks(t).map(({ href, label, icon: NavIcon }) => (
              <Link href={href} key={href} aria-label={label} title={label}>
                <NavIcon className="nav-icon" size={17} strokeWidth={1.9} aria-hidden="true" />
                <span className="nav-label">{label}</span>
              </Link>
            ))}
          </nav>

          <div className="header-actions">
            <LanguageToggle current={language} />
            <a
              className="button button-small button-primary"
              href={downloadUrl}
              aria-label={t.nav.download}
              title={t.nav.download}
            >
              <Download size={16} aria-hidden="true" />
              <span className="download-label">{t.nav.download}</span>
            </a>
            <MobileNav
              links={navLinks(t).map(({ href, label }) => ({ href, label }))}
              label={t.nav.menu}
            />
            <DockToggle />
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-sticky">
          <div className="shell hero-copy">
            <div className="hero-kicker">
              <span className="status-dot" />
              {t.hero.kicker}
            </div>
            <h1>
              {t.hero.headline} <span className="hero-accent">{t.hero.headlineAccent}</span>
            </h1>
            <p className="hero-lede">{t.hero.lede}</p>
            <div className="hero-actions">
              <a className="button button-primary" href={downloadUrl}>
                <Download size={18} aria-hidden="true" />
                {t.hero.download} {latestVersion}
              </a>
              <a
                className="button button-secondary"
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
              >
                <GitFork size={18} aria-hidden="true" />
                {t.hero.viewOnGitHub}
              </a>
            </div>
            <p className="hero-note">{t.hero.note}</p>
            <div className="scroll-hint" aria-hidden="true">
              <span className="scroll-hint-label">Scroll</span>
              <span className="scroll-hint-line" />
            </div>
          </div>

          <div className="shell hero-media-wrap">
            <TiltFrame>
              <div className="product-frame product-frame-hero">
                <div className="frame-bar" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <strong className="frame-title">ant_language / Connection launcher</strong>
                </div>
                <div className="hero-phase-stack">
                  {workflowMedia.map((media, index) => (
                    <Image
                      className="product-image hero-phase-image"
                      src={media.image}
                      width={media.width}
                      height={media.height}
                      alt={media.alt}
                      priority={index === 0}
                      key={media.image}
                      sizes="(max-width: 720px) 94vw, 1180px"
                    />
                  ))}
                </div>
              </div>
            </TiltFrame>
          </div>
          <div className="laptop-base" aria-hidden="true" />

          <div className="hero-phase-caption" aria-hidden="true">
            <p className="hero-phase-eyebrow" />
            <h3 className="hero-phase-title" />
            <p className="hero-phase-copy" />
          </div>
          <div className="hero-phase-line" aria-hidden="true" />
          <div className="hero-phase-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>

          <div className="hero-reveal" aria-hidden="true">
            <p className="eyebrow">{t.hero.revealEyebrow}</p>
            <h2>{t.hero.revealHeading}</h2>
            <div className="hero-reveal-grid">
              {engines.map((engine) => (
                <span className="hero-reveal-chip" key={engine}>
                  <EngineMark name={engine} size={15} />
                  <span className="hero-reveal-chip-name">{engine}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="signal-strip" aria-label="Product highlights">
        <div className="shell signal-grid">
          {t.signal.items.map((item) => (
            <div key={item.span}>
              <strong>{item.strong}</strong>
              <span>{item.span}</span>
            </div>
          ))}
        </div>
      </section>

      {/* infinite engine ticker — the reference sites' logo marquee,
          neumorphic chips on a recessed track */}
      <div className="engine-marquee" aria-hidden="true">
        <div className="engine-marquee-track">
          {[...engines, ...engines].map((engine, i) => (
            <span className="engine-marquee-chip" key={`${engine}-${i}`}>
              <EngineMark name={engine} size={15} />
              <span>{engine}</span>
            </span>
          ))}
        </div>
      </div>

      <section className="section features-section" id="features">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">
              <span className="eyebrow-index">01</span>
              {t.features.eyebrow}
            </p>
            <h2>{t.features.heading}</h2>
            <p>{t.features.intro}</p>
          </div>

          <div className="feature-grid">
            {t.features.cards.map((item, index) => {
              const Icon = featureIcons[index];
              return (
                <article className="feature-card" key={item.title}>
                  <span className="feature-icon">
                    <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section workflow-section" id="workflow">
        <div className="shell">
          <div className="section-heading section-heading-wide">
            <p className="eyebrow">
              <span className="eyebrow-index">02</span>
              {t.workflow.eyebrow}
            </p>
            <h2>{t.workflow.heading}</h2>
          </div>

          <div className="workflow-list">
            {t.workflow.steps.map((step, index) => {
              const media = workflowMedia[index];
              const Icon = media.icon;
              return (
                <article
                  className={`workflow-row ${index % 2 === 1 ? "workflow-row-reverse" : ""}`}
                  key={step.eyebrow}
                >
                  <div className="workflow-copy">
                    <div className="workflow-label">
                      <span>{`0${index + 1}`}</span>
                      <Icon size={18} aria-hidden="true" />
                      {step.eyebrow}
                    </div>
                    <h3>{step.title}</h3>
                    <p>{step.copy}</p>
                    <div className="workflow-check">
                      <Check size={16} aria-hidden="true" />
                      {t.workflow.check}
                    </div>
                  </div>
                  <div className="product-frame workflow-frame">
                    <div className="frame-bar" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <strong>TableR</strong>
                    </div>
                    <Image
                      className="product-image"
                      src={media.image}
                      width={media.width}
                      height={media.height}
                      alt={media.alt}
                      sizes="(max-width: 900px) 94vw, 58vw"
                    />
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section features-section" id="agent">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">
              <span className="eyebrow-index">03</span>
              {t.agent.eyebrow}
            </p>
            <h2>{t.agent.heading}</h2>
            <p>{t.agent.intro}</p>
          </div>

          <div className="feature-grid">
            {t.agent.cards.map((item, index) => {
              const Icon = agentIcons[index];
              return (
                <article className="feature-card" key={item.title}>
                  <span className="feature-icon">
                    <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </article>
              );
            })}
          </div>

          <div className="product-frame agent-mock">
            <div className="frame-bar" aria-hidden="true">
              <span />
              <span />
              <span />
              <strong>TableR / AI workspace</strong>
            </div>
            <AgentDemo
              copy={{
                prompt: t.agent.demo.prompt,
                steps: t.agent.demo.steps as [string, string, string, string, string],
                inspecting: t.agent.demo.inspecting,
                verified: t.agent.demo.verified,
                running: t.agent.demo.running,
                done: t.agent.demo.done,
              }}
            />
          </div>
        </div>
      </section>

      <section className="section erd-section">
        <div className="shell">
          <div className="erd-heading">
            <div>
              <p className="eyebrow">
                <span className="eyebrow-index">04</span>
                {t.erd.eyebrow}
              </p>
              <h2>{t.erd.heading}</h2>
            </div>
            <p>{t.erd.intro}</p>
          </div>

          <div className="product-frame erd-frame">
            <div className="frame-bar" aria-hidden="true">
              <span />
              <span />
              <span />
              <strong>ant_language / ER Diagram</strong>
            </div>
            <Image
              className="product-image"
              src="/screenshots/table-r-er-diagram.png"
              width={1920}
              height={1080}
              alt="TableR ER diagram workspace displaying database tables and relationships"
              loading="lazy"
              sizes="(max-width: 720px) 94vw, 1180px"
            />
          </div>
        </div>
      </section>

      <section className="section engines-section" id="engines">
        <div className="shell engine-layout">
          <div className="section-heading engine-heading">
            <p className="eyebrow">
              <span className="eyebrow-index">05</span>
              {t.engines.eyebrow}
            </p>
            <h2>{t.engines.heading}</h2>
            <p>{t.engines.intro}</p>
            <a
              className="text-link"
              href={`${repositoryUrl}#supported-databases`}
              target="_blank"
              rel="noreferrer"
            >
              {t.engines.details}
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>

          <div className="engine-grid">
            {engines.map((engine) => (
              <div className="engine-item" key={engine}>
                <span className="engine-mark">
                  <EngineMark name={engine} size={17} />
                </span>
                <span>{engine}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="open-source-section" id="open-source">
        <div className="shell open-source-layout">
          <div className="open-source-copy">
            <p className="eyebrow eyebrow-on-dark">
              <span className="eyebrow-index">06</span>
              {t.openSource.eyebrow}
            </p>
            <h2>{t.openSource.heading}</h2>
            <p>{t.openSource.intro}</p>
            <div className="open-source-actions">
              <a
                className="button button-light"
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
              >
                <GitFork size={18} aria-hidden="true" />
                {t.openSource.browse}
              </a>
              <a
                className="button button-dark-outline"
                href={`${repositoryUrl}/issues`}
                target="_blank"
                rel="noreferrer"
              >
                {t.openSource.issue}
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="architecture-list">
            {t.arch.map((label, index) => {
              const Icon = architectureIcons[index];
              return (
                <div key={label}>
                  <Icon size={19} aria-hidden="true" />
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="shell final-cta-inner">
          <div>
            <p className="eyebrow">{t.cta.eyebrow}</p>
            <h2>{t.cta.heading}</h2>
          </div>
          <a className="button button-primary" href={downloadUrl}>
            <Download size={18} aria-hidden="true" />
            {t.cta.download}
          </a>
        </div>
      </section>

      <SiteFooter t={t} />

      <button type="button" className="back-to-top" aria-label="Back to top">
        <ArrowRight size={17} aria-hidden="true" style={{ transform: "rotate(-90deg)" }} />
      </button>
      <a className="mobile-cta" href={downloadUrl}>
        <Download size={16} aria-hidden="true" />
        {t.hero.download} {latestVersion}
      </a>
    </main>
  );
}
