"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const COLLAPSE_THRESHOLD = 560;

/**
 * Collapses long changelog entries behind a "Show more" fade. Entries
 * shorter than the threshold render untouched — no button, no clipping.
 */
export function CollapsibleEntry({
  children,
  className,
  id,
  moreLabel,
  lessLabel,
}: {
  children: ReactNode;
  className: string;
  id: string;
  moreLabel: string;
  lessLabel: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [collapsible, setCollapsible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight > COLLAPSE_THRESHOLD) setCollapsible(true);
  }, []);

  return (
    <article
      ref={ref}
      id={id}
      className={`${className}${collapsible ? " is-collapsible" : ""}${
        collapsible && !expanded ? " is-collapsed" : ""
      }`}
    >
      <div className="changelog-entry-body">{children}</div>
      {collapsible ? (
        <button
          type="button"
          className="changelog-expand"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? lessLabel : moreLabel}
          <ChevronDown size={14} aria-hidden="true" className={expanded ? "is-open" : undefined} />
        </button>
      ) : null}
    </article>
  );
}
