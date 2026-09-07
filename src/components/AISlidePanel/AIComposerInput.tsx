import { Loader2, Bot } from "lucide-react";
import type { AIProviderConfig } from "../../types/ai";

interface AIComposerInputProps {
  prompt: string;
  isLoading: boolean;
  activeProvider: AIProviderConfig | undefined;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onGenerate: () => void;
}

export function AIComposerInput({
  prompt,
  isLoading,
  activeProvider,
  textareaRef,
  onPromptChange,
  onKeyDown,
  onGenerate,
}: AIComposerInputProps) {
  return (
    <div className="ai-slide-composer-card">
      <div className="ai-slide-composer-head">
        <label className="ai-slide-section-label">Your Request</label>
        <span className="ai-slide-hotkey">Enter to generate</span>
      </div>

      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Describe the SQL you want to create, modify, or debug..."
        className="ai-slide-textarea"
        autoFocus
      />

      <div className="ai-slide-composer-footer">
        <div className="ai-slide-helper-copy">
          <span className="ai-slide-helper-title">
            {activeProvider?.allow_schema_context ? "Context-aware" : "Privacy mode"}
          </span>
          <span className="ai-slide-helper-text">
            {activeProvider?.allow_schema_context
              ? "Uses your current schema so the output stays grounded in real tables."
              : "Schema context sharing is off, so the AI only sees your prompt."}
          </span>
        </div>

        <button
          onClick={onGenerate}
          disabled={isLoading || !prompt.trim()}
          className="btn btn-primary ai-slide-submit-btn"
        >
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
          {isLoading ? "Generating..." : "Generate SQL"}
        </button>
      </div>
    </div>
  );
}
