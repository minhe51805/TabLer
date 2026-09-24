"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

/**
 * "Was this helpful?" widget — a quiet yes/no at the foot of each doc
 * page. The vote is stored locally (no backend); the point is the
 * affordance, not telemetry.
 */
export function DocFeedback({
  label,
  yesLabel,
  noLabel,
  thanksLabel,
}: {
  label: string;
  yesLabel: string;
  noLabel: string;
  thanksLabel: string;
}) {
  const [voted, setVoted] = useState<"yes" | "no" | null>(null);

  if (voted) {
    return (
      <div className="doc-feedback is-voted" role="status">
        {thanksLabel}
      </div>
    );
  }

  return (
    <div className="doc-feedback">
      <span>{label}</span>
      <div className="doc-feedback-actions">
        <button
          type="button"
          className="doc-feedback-btn"
          onClick={() => setVoted("yes")}
          aria-label={yesLabel}
        >
          <ThumbsUp size={14} aria-hidden="true" />
          {yesLabel}
        </button>
        <button
          type="button"
          className="doc-feedback-btn"
          onClick={() => setVoted("no")}
          aria-label={noLabel}
        >
          <ThumbsDown size={14} aria-hidden="true" />
          {noLabel}
        </button>
      </div>
    </div>
  );
}
