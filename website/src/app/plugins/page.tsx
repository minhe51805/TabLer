import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  Cloud,
  Download,
  ExternalLink,
  FileText,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  formatBundleSize,
  getPluginCatalog,
  type PluginCatalogEntry,
  type PluginCategory,
} from "@/lib/plugins";
import { getSiteLanguage } from "@/lib/language";
import { getDictionary } from "@/lib/i18n";
import { repositoryName, repositoryOwner } from "@/lib/site";
import { LanguageToggle } from "../LanguageToggle";

export const metadata: Metadata = {
  title: "TableR plugins",
  description:
    "Browse and download official TableR database driver plugins. Install from the app's Plugin Manager or from a downloaded bundle.",
};

export const revalidate = 0;

const CATEGORY_ORDER: PluginCategory[] = ["http", "native", "format"];

const CATEGORY_ICON = {
  http: Cloud,
  native: Server,
  format: FileText,
} as const;

export default async function PluginsPage() {
  const language = await getSiteLanguage();
  const t = getDictionary(language);
  const catalog = await getPluginCatalog();
  const p = t.plugins;

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    plugins: catalog.plugins.filter((item) => item.category === category),
  })).filter((group) => group.plugins.length > 0);

  return (
    <main className="plugins-page" id="main">
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
          <div className="header-actions">
            <LanguageToggle current={language} />
            <Link className="button button-small button-secondary" href="/">
              <ArrowLeft size={16} aria-hidden="true" />
              {p.back}
            </Link>
          </div>
        </div>
      </header>

      <div className="shell plugins-shell">
        <section className="plugins-intro">
          <div>
            <p className="eyebrow">{p.eyebrow}</p>
            <h1>{p.heading}</h1>
            <p>{p.intro}</p>
          </div>
          <div className="plugins-trust">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>{p.trustTitle}</strong>
              <span>{p.trustCopy(catalog.counts.total)}</span>
            </div>
          </div>
        </section>

        {catalog.plugins.length === 0 ? (
          <div className="plugins-empty">{p.empty}</div>
        ) : (
          <>
            <div className="plugins-summary">
              <span className="plugins-chip plugins-chip-ready">
                {catalog.counts.installable} · {p.counts.installable}
              </span>
              {catalog.counts.total - catalog.counts.installable > 0 ? (
                <span className="plugins-chip plugins-chip-pending">
                  {catalog.counts.total - catalog.counts.installable} ·{" "}
                  {p.counts.pending}
                </span>
              ) : null}
            </div>

            {catalog.registryUrl ? (
              <aside className="plugins-registry">
                <strong>{p.registryTitle}</strong>
                <code>{catalog.registryUrl}</code>
                <span>{p.registryCopy}</span>
              </aside>
            ) : null}

            {groups.map((group) => {
              const GroupIcon = CATEGORY_ICON[group.category];
              const groupCopy = p.groups[group.category];
              return (
                <section key={group.category} className="plugins-group">
                  <div className="plugins-group-head">
                    <GroupIcon size={18} aria-hidden="true" />
                    <div>
                      <h2>{groupCopy.title}</h2>
                      <p>{groupCopy.copy}</p>
                    </div>
                  </div>
                  <div className="plugin-grid">
                    {group.plugins.map((plugin) => (
                      <PluginCard
                        key={plugin.id}
                        plugin={plugin}
                        labels={p.card}
                      />
                    ))}
                  </div>
                </section>
              );
            })}

            <aside className="plugins-install">
              <strong>{p.install.title}</strong>
              <ol>
                {p.install.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </aside>

            <aside className="plugins-help">
              <ShieldCheck size={18} aria-hidden="true" />
              <div>
                <strong>{p.security.title}</strong>
                <span>{p.security.copy}</span>
              </div>
            </aside>
          </>
        )}
      </div>

      <footer className="download-footer">
        <div className="shell">
          <span>{t.download.footerLicense}</span>
          <a
            href={`https://github.com/${repositoryOwner}/${repositoryName}`}
            target="_blank"
            rel="noreferrer"
          >
            {t.download.allReleases}
          </a>
        </div>
      </footer>
    </main>
  );
}

type PluginCardLabels = ReturnType<typeof getDictionary>["plugins"]["card"];

function PluginCard({
  plugin,
  labels,
}: {
  plugin: PluginCatalogEntry;
  labels: PluginCardLabels;
}) {
  const engineLabel = plugin.engine?.label ?? plugin.name;
  return (
    <article className="plugin-card">
      <div className="plugin-card-head">
        <div className="plugin-card-title">
          <h3>{engineLabel}</h3>
          <span className="plugin-card-version">v{plugin.version}</span>
        </div>
        <span
          className={
            plugin.binaryPending
              ? "plugin-badge plugin-badge-pending"
              : "plugin-badge plugin-badge-ready"
          }
        >
          {plugin.binaryPending ? labels.binaryPending : labels.installNow}
        </span>
      </div>

      <p className="plugin-card-desc">{plugin.description}</p>

      <dl className="plugin-card-meta">
        {plugin.engine ? (
          <div>
            <dt>{labels.protocol}</dt>
            <dd>
              <code>{plugin.engine.protocol}</code>
            </dd>
          </div>
        ) : plugin.formats.length > 0 ? (
          <div>
            <dt>{labels.formatsLabel}</dt>
            <dd>{plugin.formats.join(", ")}</dd>
          </div>
        ) : null}
        <div>
          <dt>{labels.size}</dt>
          <dd>{formatBundleSize(plugin.bundle.size)}</dd>
        </div>
      </dl>

      {plugin.permissions.length > 0 ? (
        <div className="plugin-card-perms">
          <span className="plugin-perms-label">{labels.permissions}</span>
          <div className="plugin-perms-list">
            {plugin.permissions.map((perm) => (
              <span key={perm} className="plugin-perm">
                {perm}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="plugin-card-actions">
        <a
          className="button button-small button-primary"
          href={plugin.bundle.path}
          download
        >
          <Download size={15} aria-hidden="true" />
          {labels.download}
        </a>
        {plugin.docsSlug ? (
          <Link
            className="button button-small button-secondary"
            href={`/docs/${plugin.docsSlug}`}
          >
            <ExternalLink size={15} aria-hidden="true" />
            {labels.docs}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
