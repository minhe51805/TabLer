import { Database } from "lucide-react";
import { APP_DEVELOPER, APP_VERSION } from "./types";

export function StartupBrandingPanel() {
  return (
    <section className="startup-manager-hero">
      <div className="startup-manager-hero-main">
        <div className="startup-manager-brand-icon">
          <Database className="w-8 h-8 text-[var(--accent)]" />
        </div>

        <div className="startup-manager-brand-copy">
          <h2 className="startup-manager-app-name">TabLer</h2>
          <p className="startup-manager-app-version">Version {APP_VERSION}</p>
          <p className="startup-manager-app-developer">{APP_DEVELOPER}</p>
        </div>
      </div>
    </section>
  );
}
