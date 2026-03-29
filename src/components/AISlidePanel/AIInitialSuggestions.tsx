import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { PROMPT_IDEAS } from "./AISlidePanelUtils";

interface AIInitialSuggestionsProps {
  onUseSuggestion: (prompt: string) => void;
}

export function AIInitialSuggestions({ onUseSuggestion }: AIInitialSuggestionsProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className={`ai-workspace-suggestions-card ${!isExpanded ? "is-collapsed" : ""}`}>
      <div
        className="ai-workspace-suggestions-head"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
      >
        <span className="ai-workspace-section-label">Quick Starts</span>
        <span className="ai-workspace-suggestions-note">Tap to fill the prompt</span>
        <ChevronDown className={`ai-workspace-suggestions-toggle ${isExpanded ? "expanded" : "collapsed"}`} size={14} />
      </div>

      {isExpanded && (
        <div className="ai-workspace-suggestions-grid">
          {PROMPT_IDEAS.map((idea) => (
            <button
              key={idea.title}
              type="button"
              className="ai-workspace-suggestion-btn"
              onClick={() => onUseSuggestion(idea.prompt)}
            >
              <span className="ai-workspace-suggestion-title">{idea.title}</span>
              <span className="ai-workspace-suggestion-copy">{idea.prompt}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
