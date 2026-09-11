"use client";

import { useEffect, useState } from "react";
import type { DocHeading } from "@/lib/docs";

/**
 * "On this page" table of contents with scroll-spy. Highlights the heading
 * closest to the top of the viewport as the reader scrolls.
 */
export function DocToc({
  headings,
  label,
}: {
  headings: DocHeading[];
  label: string;
}) {
  const [activeId, setActiveId] = useState<string>(headings[0]?.id ?? "");

  useEffect(() => {
    if (headings.length === 0) return;

    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => Boolean(element));

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );

        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-88px 0px -70% 0px", threshold: [0, 1] },
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <aside className="docs-toc" aria-label={label}>
      <div className="docs-toc-inner">
        <p className="docs-toc-label">{label}</p>
        <ul>
          {headings.map((heading) => (
            <li
              key={heading.id}
              className={heading.level === 3 ? "docs-toc-sub" : undefined}
            >
              <a
                href={`#${heading.id}`}
                className={`docs-toc-link${
                  activeId === heading.id ? " is-active" : ""
                }`}
                aria-current={activeId === heading.id ? "true" : undefined}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
