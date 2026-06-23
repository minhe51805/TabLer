import Image from "next/image";
import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Database,
  Download,
  GitBranch,
  GitFork,
  KeyRound,
  Layers3,
  Network,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { getTableRReleases } from "@/lib/github-releases";

const downloadUrl = "/download";
const repositoryUrl = "https://github.com/minhe51805/TabLer";

export const revalidate = 300;

const featureItems = [
  {
    icon: Database,
    title: "One place for every database",
    copy: "Save connections, browse schemas, inspect objects, and move between engines without rebuilding your workspace.",
  },
  {
    icon: Code2,
    title: "A query editor built for flow",
    copy: "Write SQL in Monaco, keep multiple tabs open, review results, chart data, and export without leaving the query.",
  },
  {
    icon: Bot,
    title: "AI that knows the workspace",
    copy: "Ask questions with schema context, generate SQL, explain queries, and keep the conversation beside the work.",
  },
  {
    icon: Network,
    title: "ER diagrams on demand",
    copy: "Select the tables that matter, trace relationships, use the minimap, and export a diagram when the model is clear.",
  },
];

const workflowItems = [
  {
    step: "01",
    icon: KeyRound,
    eyebrow: "CONNECT",
    title: "Start with a calmer connection launcher.",
    copy: "Search saved profiles, create a connection, and jump back into recent work. Credentials stay in the operating system keyring instead of the interface.",
    image: "/screenshots/table-r-connection-launcher.png",
    alt: "TableR connection launcher showing saved PostgreSQL connections",
    width: 1176,
    height: 769,
  },
  {
    step: "02",
    icon: Terminal,
    eyebrow: "QUERY",
    title: "Keep the editor, data, and tools in one workspace.",
    copy: "Explore objects from the sidebar, write SQL with Monaco, inspect results, switch to charts, and use the terminal without breaking context.",
    image: "/screenshots/table-r-query-workspace.png",
    alt: "TableR query workspace with SQL editor and result table",
    width: 1296,
    height: 809,
  },
  {
    step: "03",
    icon: Sparkles,
    eyebrow: "UNDERSTAND",
    title: "Bring AI close to the query, not over it.",
    copy: "Use the assistant when it helps and collapse it when it does not. The workspace remains readable, with actions grouped around the conversation instead of scattered through it.",
    image: "/screenshots/table-r-ai-workspace.png",
    alt: "TableR AI workspace beside the SQL editor",
    width: 1296,
    height: 809,
  },
];

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

const architectureItems = [
  { icon: Layers3, label: "Tauri 2 desktop shell" },
  { icon: Workflow, label: "React 19 interface" },
  { icon: ShieldCheck, label: "Rust backend" },
  { icon: Code2, label: "Monaco editor" },
  { icon: GitBranch, label: "GPL-3.0 licensed" },
  { icon: Zap, label: "Local-first workflow" },
];

export default async function Home() {
  const releases = await getTableRReleases();
  const latestVersion = releases[0]?.tag ?? "latest";

  return (
    <main>
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
            <a href="#features">Features</a>
            <a href="#workflow">Workflow</a>
            <a href="#engines">Engines</a>
            <a href="#open-source">Open source</a>
          </nav>

          <a
            className="button button-small button-primary"
            href={downloadUrl}
          >
            <Download size={16} aria-hidden="true" />
            Download
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="shell hero-copy">
          <div className="hero-kicker">
            <span className="status-dot" />
            Open-source database workspace
          </div>
          <h1>TableR</h1>
          <p className="hero-lede">
            Query, explore, visualize, and understand your databases from one
            focused desktop workspace.
          </p>
          <div className="hero-actions">
            <a
              className="button button-primary"
              href={downloadUrl}
            >
              <Download size={18} aria-hidden="true" />
              Download {latestVersion}
            </a>
            <a
              className="button button-secondary"
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
            >
              <GitFork size={18} aria-hidden="true" />
              View on GitHub
            </a>
          </div>
          <p className="hero-note">Windows, macOS, and Linux</p>
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
              width={1296}
              height={809}
              alt="TableR desktop app showing a PostgreSQL query and its result set"
              priority
              sizes="(max-width: 720px) 94vw, 1180px"
            />
          </div>
        </div>
      </section>

      <section className="signal-strip" aria-label="Product highlights">
        <div className="shell signal-grid">
          <div>
            <strong>18</strong>
            <span>database engines</span>
          </div>
          <div>
            <strong>One</strong>
            <span>unified workspace</span>
          </div>
          <div>
            <strong>Local</strong>
            <span>desktop experience</span>
          </div>
          <div>
            <strong>GPLv3</strong>
            <span>open-source license</span>
          </div>
        </div>
      </section>

      <section className="section features-section" id="features">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">THE WORKSPACE</p>
            <h2>Less switching. More understanding.</h2>
            <p>
              TableR keeps the tools around your data close enough to be useful
              and quiet enough to stay out of the way.
            </p>
          </div>

          <div className="feature-grid">
            {featureItems.map((item) => {
              const Icon = item.icon;
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
            <p className="eyebrow">A COMPLETE LOOP</p>
            <h2>From connection to answer, without losing the thread.</h2>
          </div>

          <div className="workflow-list">
            {workflowItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <article
                  className={`workflow-row ${index % 2 === 1 ? "workflow-row-reverse" : ""}`}
                  key={item.step}
                >
                  <div className="workflow-copy">
                    <div className="workflow-label">
                      <span>{item.step}</span>
                      <Icon size={18} aria-hidden="true" />
                      {item.eyebrow}
                    </div>
                    <h3>{item.title}</h3>
                    <p>{item.copy}</p>
                    <div className="workflow-check">
                      <Check size={16} aria-hidden="true" />
                      Designed for repeated, everyday database work
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
                      src={item.image}
                      width={item.width}
                      height={item.height}
                      alt={item.alt}
                      sizes="(max-width: 900px) 94vw, 58vw"
                    />
                  </div>
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
              <p className="eyebrow">ENTITY RELATIONSHIPS</p>
              <h2>See the shape of a database.</h2>
            </div>
            <p>
              Build an ER diagram from selected tables, navigate large schemas
              with a minimap, and export the result for the next conversation.
            </p>
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
              width={1296}
              height={809}
              alt="TableR ER diagram workspace displaying database tables and relationships"
              sizes="(max-width: 720px) 94vw, 1180px"
            />
          </div>
        </div>
      </section>

      <section className="section engines-section" id="engines">
        <div className="shell engine-layout">
          <div className="section-heading engine-heading">
            <p className="eyebrow">ENGINE COVERAGE</p>
            <h2>Your database is probably already invited.</h2>
            <p>
              Use the same familiar workflow across relational, analytical,
              document, cache, and cloud data platforms.
            </p>
            <a
              className="text-link"
              href={`${repositoryUrl}#supported-databases`}
              target="_blank"
              rel="noreferrer"
            >
              Explore support details
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
            <p className="eyebrow eyebrow-on-dark">BUILT IN THE OPEN</p>
            <h2>A desktop tool you can inspect, shape, and trust.</h2>
            <p>
              TableR combines a Tauri shell, a React interface, and a Rust
              backend. Read the code, open an issue, or contribute the database
              workflow you wish existed.
            </p>
            <div className="open-source-actions">
              <a
                className="button button-light"
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
              >
                <GitFork size={18} aria-hidden="true" />
                Browse source
              </a>
              <a
                className="button button-dark-outline"
                href={`${repositoryUrl}/issues`}
                target="_blank"
                rel="noreferrer"
              >
                Open an issue
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="architecture-list">
            {architectureItems.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label}>
                  <Icon size={19} aria-hidden="true" />
                  <span>{item.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="shell final-cta-inner">
          <div>
            <p className="eyebrow">READY TO EXPLORE?</p>
            <h2>Give your databases a better workspace.</h2>
          </div>
          <a
            className="button button-primary"
            href={downloadUrl}
          >
            <Download size={18} aria-hidden="true" />
            Download TableR
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
          <p>Built by the TableR Team. Licensed under GPL-3.0.</p>
          <div className="footer-links">
            <a href={repositoryUrl} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={downloadUrl}>Download</a>
            <a
              href="https://buymeacoffee.com/minjev"
              target="_blank"
              rel="noreferrer"
            >
              Support
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
