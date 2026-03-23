import { PROMPT_IDEAS } from "./AISlidePanelUtils";

interface AIInitialSuggestionsProps {
  onUseSuggestion: (prompt: string) => void;
}

export function AIInitialSuggestions({ onUseSuggestion }: AIInitialSuggestionsProps) {
  return (
    <div className="ai-slide-suggestions-card">
      <div className="ai-slide-suggestions-head">
        <span className="ai-slide-section-label">Quick Starts</span>
        <span className="ai-slide-suggestions-note">Tap to fill the prompt</span>
      </div>

      <div className="ai-slide-suggestions-grid">
        {PROMPT_IDEAS.map((idea) => (
          <button
            key={idea.title}
            type="button"
            className="ai-slide-suggestion-btn"
            onClick={() => onUseSuggestion(idea.prompt)}
          >
            <span className="ai-slide-suggestion-title">{idea.title}</span>
            <span className="ai-slide-suggestion-copy">{idea.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
