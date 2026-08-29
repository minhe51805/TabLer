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
  KeyRound,
  Layers3,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { getTableRReleases } from "@/lib/github-releases";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary } from "@/lib/i18n";
import { repositoryUrl } from "@/lib/site";
import { LanguageToggle } from "./LanguageToggle";

const downloadUrl = "/download";

export const revalidate = 0;

const featureIcons = [Database, Code2, Bot, Network];

const workflowMedia = [
  {
    icon: KeyRound,
    image: "/screenshots/table-r-connection-launcher.png",
    alt: "TableR connection launcher showing saved PostgreSQL connections",
    width: 1280,
    height: 801,
  },
  {
    icon: Terminal,
    image: "/screenshots/table-r-query-workspace.png",
    alt: "TableR query workspace with SQL editor and result table",
    width: 1280,
    height: 801,
  },
  {
    icon: Sparkles,
    image: "/screenshots/table-r-ai-workspace.png",
    alt: "TableR AI workspace beside the SQL editor",
    width: 1280,
    height: 801,
  },
];

const agentIcons = [Eye, BookMarked, ShieldCheck, RefreshCw];

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
];

const architectureIcons = [Layers3, Workflow, ShieldCheck, Code2, GitBranch, Zap];

export default async function Home() {
  const language = await getSiteLanguage();
  const t = getDictionary(language);
  const releases = await getTableRReleases();
  const latestVersion = releases[0]?.tag ?? "latest";

  return (
    <main id="main">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="#top" aria-label="TableR home">
            <Image
              src="/tabler-brand-mark.png"
              width={36}
              height={36}
              alt=""
              priority
            />
            <span>TableR</span>
          </a>

          <nav className="main-nav" aria-label="Main navigation">
            <a href="#features">{t.nav.features}</a>
            <a href="#workflow">{t.nav.workflow}</a>
            <a href="#agent">{t.nav.agent}</a>
            <a href="#engines">{t.nav.engines}</a>
            <a href="#open-source">{t.nav.openSource}</a>
            <a href="/changelog">{t.nav.changelog}</a>
          </nav>

          <div className="header-actions">
            <LanguageToggle current={language} />
            <a
              className="button button-small button-primary"
              href={downloadUrl}
            >
              <Download size={16} aria-hidden="true" />
              {t.nav.download}
            </a>
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="shell hero-copy">
          <div className="hero-kicker">
            <span className="status-dot" />
            {t.hero.kicker}
          </div>
          <h1>TableR</h1>
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
        </div>

        <div className="shell hero-media-wrap">
          <div className="product-frame product-frame-hero">
            <div className="frame-bar" aria-hidden="true">
              <span />
              <span />
              <span />
              <strong>ant_language / Query workspace</strong>
            </div>
            <Image
              className="product-image"
              src="/screenshots/table-r-query-workspace.png"
              width={1280}
              height={801}
              alt="TableR desktop app showing a PostgreSQL query and its result set"
              priority
              sizes="(max-width: 720px) 94vw, 1180px"
            />
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

      <section className="section features-section" id="features">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">{t.features.eyebrow}</p>
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
            <p className="eyebrow">{t.workflow.eyebrow}</p>
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
            <p className="eyebrow">{t.agent.eyebrow}</p>
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
        </div>
      </section>

      <section className="section erd-section">
        <div className="shell">
          <div className="erd-heading">
            <div>
              <p className="eyebrow">{t.erd.eyebrow}</p>
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
              width={1280}
              height={801}
              alt="TableR ER diagram workspace displaying database tables and relationships"
              sizes="(max-width: 720px) 94vw, 1180px"
            />
          </div>
        </div>
      </section>

      <section className="section engines-section" id="engines">
        <div className="shell engine-layout">
          <div className="section-heading engine-heading">
            <p className="eyebrow">{t.engines.eyebrow}</p>
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
            {engines.map((engine, index) => (
              <div className="engine-item" key={engine}>
                <span className={`engine-mark engine-mark-${(index % 4) + 1}`}>
                  <Database size={16} aria-hidden="true" />
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
            <p className="eyebrow eyebrow-on-dark">{t.openSource.eyebrow}</p>
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

      <footer>
        <div className="shell footer-inner">
          <a className="brand footer-brand" href="#top" aria-label="TableR home">
            <Image
              src="/tabler-brand-mark.png"
              width={30}
              height={30}
              alt=""
            />
            <span>TableR</span>
          </a>
          <p>{t.footer.built}</p>
          <div className="footer-links">
            <a href={repositoryUrl} target="_blank" rel="noreferrer">
              {t.footer.github}
            </a>
            <a href={downloadUrl}>{t.footer.download}</a>
            <Link href="/changelog">{t.footer.changelog}</Link>
            <a
              href="https://buymeacoffee.com/minjev"
              target="_blank"
              rel="noreferrer"
            >
              {t.footer.support}
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
