"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  Code2,
  HelpCircle,
  Keyboard,
  Layers3,
  Menu,
  Network,
  PlugZap,
  Puzzle,
  Rocket,
  Table,
  type LucideIcon,
} from "lucide-react";
import { docHref } from "@/lib/docs";
import type { DocGroup } from "@/lib/docs";

const iconMap: Record<string, LucideIcon> = {
  BookOpen,
  Rocket,
  PlugZap,
  Puzzle,
  Code2,
  Table,
  Network,
  Bot,
  Keyboard,
  Layers3,
  HelpCircle,
};

export type DocsNavItem = {
  slug: string;
  icon: string;
  title: string;
};

export type DocsSubLink = {
  href: string;
  label: string;
};

export function DocsSidebar({
  items,
  groups,
  label,
  menuLabel,
  connectSubnav = [],
}: {
  items: DocsNavItem[];
  groups: DocGroup[];
  label: string;
  menuLabel: string;
  connectSubnav?: DocsSubLink[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const connectionsHref = docHref("connections");
  const inConnectionsSection =
    pathname === connectionsHref ||
    connectSubnav.some((link) => link.href === pathname);
  // null = follow the route (auto-open in the connections section); a boolean
  // is an explicit user toggle that overrides the route-based default.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const openConnections = manualOpen ?? inConnectionsSection;

  const bySlug = new Map(items.map((item) => [item.slug, item]));

  return (
    <aside className="docs-sidebar" aria-label={menuLabel}>
      <button
        type="button"
        className="docs-menu-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Menu size={16} aria-hidden="true" />
        {label}
      </button>

      <nav className={`docs-nav${open ? " is-open" : ""}`}>
        {groups.map((group) => (
          <div className="docs-nav-group" key={group.label}>
            <p className="docs-nav-group-label">{group.label}</p>
            <ul>
              {group.slugs.map((slug) => {
                const item = bySlug.get(slug);
                if (!item) return null;
                const href = docHref(item.slug);
                const isActive = pathname === href;
                const Icon = iconMap[item.icon] ?? BookOpen;
                const hasSub =
                  item.slug === "connections" && connectSubnav.length > 0;

                if (hasSub) {
                  return (
                    <li key={href} className="docs-nav-item">
                      <button
                        type="button"
                        className={`docs-nav-link docs-nav-parent${
                          isActive ? " is-active" : ""
                        }`}
                        aria-current={isActive ? "page" : undefined}
                        aria-expanded={openConnections}
                        onClick={() => {
                          setOpen(false);
                          const next = !openConnections;
                          setManualOpen(next);
                          if (next) router.push(connectionsHref);
                        }}
                      >
                        <Icon size={16} aria-hidden="true" />
                        <span>{item.title}</span>
                        <ChevronDown
                          className={`docs-nav-chevron${
                            openConnections ? " is-open" : ""
                          }`}
                          size={15}
                          aria-hidden="true"
                        />
                      </button>
                      {openConnections ? (
                        <ul className="docs-subnav">
                          {connectSubnav.map((link) => {
                            const isSubActive = pathname === link.href;
                            return (
                              <li key={link.href}>
                                <Link
                                  href={link.href}
                                  className={`docs-subnav-link${
                                    isSubActive ? " is-active" : ""
                                  }`}
                                  aria-current={isSubActive ? "page" : undefined}
                                  onClick={() => setOpen(false)}
                                >
                                  {link.label}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </li>
                  );
                }

                return (
                  <li key={href}>
                    <Link
                      href={href}
                      className={`docs-nav-link${isActive ? " is-active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setOpen(false)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{item.title}</span>
                      <ChevronRight
                        className="docs-nav-caret"
                        size={14}
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
