import { Database, Shield, Zap, Globe } from "lucide-react";
import { APP_DEVELOPER, APP_VERSION } from "./types";

export function StartupBrandingPanel() {
  return (
    <section className="startup-manager-hero">
      {/* Ambient glow */}
      <div className="startup-hero-glow" />

      {/* Brand Icon */}
      <div className="startup-manager-hero-main">
        <div className="startup-manager-brand-icon">
          <Database className="w-6 h-6 text-[var(--fintech-green)]" />
        </div>

        <div className="startup-manager-brand-copy">
          <span className="startup-manager-kicker">Database Client</span>
          <h2 className="startup-manager-app-name">TabLer</h2>
          <p className="startup-manager-app-version">v{APP_VERSION}</p>
          <p className="startup-manager-app-developer">{APP_DEVELOPER}</p>
        </div>
      </div>

      {/* Feature Pills */}
      <div className="startup-manager-app-meta">
        <span className="startup-manager-pill accent">
          <Shield className="w-3 h-3" />
          Secure
        </span>
        <span className="startup-manager-pill accent">
          <Zap className="w-3 h-3" />
          Fast
        </span>
        <span className="startup-manager-pill accent">
          <Globe className="w-3 h-3" />
          Cross-platform
        </span>
      </div>

      {/* Mini chart preview */}
      <div className="startup-hero-chart">
        <svg viewBox="0 0 120 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="startup-hero-chart-svg">
          <defs>
            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--fintech-green)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--fintech-cyan)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="chartLineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--fintech-green)" />
              <stop offset="100%" stopColor="var(--fintech-cyan)" />
            </linearGradient>
          </defs>
          <path
            d="M0 28 L15 22 L30 25 L45 18 L60 20 L75 12 L90 8 L105 14 L120 6"
            stroke="url(#chartLineGrad)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M0 28 L15 22 L30 25 L45 18 L60 20 L75 12 L90 8 L105 14 L120 6 L120 36 L0 36 Z"
            fill="url(#chartGrad)"
          />
        </svg>
      </div>
    </section>
  );
}
