"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Search } from "lucide-react";
import { docHref } from "@/lib/docs";

export type DocsSearchItem = {
  slug: string;
  title: string;
  description: string;
  /** flattened plain-text of the page's blocks for full-text matching */
  body: string;
};

/**
 * Client-side docs search: filters pages by title/description/body and
 * navigates on Enter or click. Results render in a dropdown under the
 * input; Escape closes it.
 */
export function DocsSearch({
  items,
  placeholder,
}: {
  items: DocsSearchItem[];
  placeholder: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.body.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [items, query]);

  // reset the highlighted result whenever the query changes
  const updateQuery = (value: string) => {
    setQuery(value);
    setActive(0);
    setOpen(true);
  };

  // close the dropdown on outside click
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const go = (slug: string) => {
    setOpen(false);
    setQuery("");
    router.push(docHref(slug));
  };

  return (
    <div className="docs-search" ref={rootRef}>
      <Search size={15} aria-hidden="true" className="docs-search-icon" />
      <input
        type="search"
        className="docs-search-input"
        placeholder={placeholder}
        value={query}
        aria-label={placeholder}
        onChange={(event) => updateQuery(event.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            return;
          }
          if (results.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((i) => (i + 1) % results.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => (i - 1 + results.length) % results.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            go(results[active].slug);
          }
        }}
      />
      {open && results.length > 0 ? (
        <ul className="docs-search-results" role="listbox">
          {results.map((item, i) => (
            <li key={item.slug} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`docs-search-result${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item.slug)}
              >
                <FileText size={14} aria-hidden="true" />
                <span>
                  <strong>{item.title}</strong>
                  <em>{item.description}</em>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
