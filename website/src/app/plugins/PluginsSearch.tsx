"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

/**
 * Client-side plugin filter — hides .plugin-card elements whose data-name
 * doesn't contain the query. Cards stay server-rendered; this only toggles
 * visibility, so the page works without JS.
 */
export function PluginsSearch({ placeholder }: { placeholder: string }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const cards = document.querySelectorAll<HTMLElement>(".plugin-card");
    const q = query.trim().toLowerCase();
    for (const card of cards) {
      const match = !q || (card.dataset.name ?? "").includes(q);
      card.hidden = !match;
    }
    // hide empty group sections when every card inside is filtered out
    document.querySelectorAll<HTMLElement>(".plugins-group").forEach((group) => {
      const anyVisible = Array.from(group.querySelectorAll<HTMLElement>(".plugin-card")).some(
        (card) => !card.hidden,
      );
      group.hidden = !anyVisible;
    });
  }, [query]);

  // "/" focuses the field, same convention as the docs search
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="plugins-search">
      <Search size={15} aria-hidden="true" className="plugins-search-icon" />
      <input
        ref={inputRef}
        type="search"
        className="plugins-search-input"
        placeholder={placeholder}
        aria-label={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <kbd className="docs-search-kbd" aria-hidden="true">
        /
      </kbd>
    </div>
  );
}
