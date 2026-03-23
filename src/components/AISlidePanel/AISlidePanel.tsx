import { Loader2, Sparkles, X } from "lucide-react";
import { useAISlidePanel } from "./hooks/use-ai-slide-panel";
import { AIContextPanel } from "./AIContextPanel";
import { AIComposerInput } from "./AIComposerInput";
import { AIResponseCard } from "./AIResponseCard";
import { AIInitialSuggestions } from "./AIInitialSuggestions";
import { AIEmptyState } from "./AIEmptyState";

interface Props {
  isOpen: boolean;
  initialPrompt?: string;
  initialPromptNonce?: number;
  onClose: () => void;
}

export function AISlidePanel({
  isOpen,
  initialPrompt = "",
  initialPromptNonce = 0,
  onClose,
}: Props) {
  const {
    prompt,
    setPrompt,
    response,
    responseRisk,
    isLoading,
    error,
    textareaRef,
    activeProvider,
    tableContextCount,
    currentDatabase,
    handleGenerate,
    handleKeyDown,
    handleCopy,
    handleInsert,
    handleUseSuggestion,
  } = useAISlidePanel({ isOpen, initialPrompt, initialPromptNonce });

  if (!isOpen) return null;

  return (
    <div className="ai-slide-panel">
      <div className="ai-slide-panel-header">
        <div className="ai-slide-panel-titlebar">
          <div className="ai-slide-panel-icon">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="ai-slide-panel-copy">
            <span className="ai-slide-panel-kicker">AI Workspace</span>
            <h3 className="ai-slide-panel-title">Ask AI Assistant</h3>
            <p className="ai-slide-panel-subtitle">
              Draft SQL from plain language using the current database context.
            </p>
          </div>
        </div>
        <button onClick={onClose} className="ai-slide-panel-close" title="Close AI Assistant">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="ai-slide-panel-body">
        <AIContextPanel
          currentDatabase={currentDatabase}
          tableContextCount={tableContextCount}
          activeProvider={activeProvider}
        />

        <AIComposerInput
          prompt={prompt}
          isLoading={isLoading}
          activeProvider={activeProvider}
          textareaRef={textareaRef}
          onPromptChange={setPrompt}
          onKeyDown={handleKeyDown}
          onGenerate={handleGenerate}
        />

        {error && (
          <div className="ai-slide-alert error">
            <p>{error}</p>
          </div>
        )}

        {!prompt && !response && !isLoading && (
          <AIInitialSuggestions onUseSuggestion={handleUseSuggestion} />
        )}

        {isLoading && (
          <div className="ai-slide-loading-card">
            <div className="ai-slide-loading-icon">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
            <div className="ai-slide-loading-copy">
              <span className="ai-slide-loading-title">Generating SQL</span>
              <span className="ai-slide-loading-text">
                Reviewing your schema and composing a query that fits the current database.
              </span>
            </div>
          </div>
        )}

        {response && (
          <AIResponseCard
            response={response}
            responseRisk={responseRisk}
            onInsert={handleInsert}
            onCopy={handleCopy}
          />
        )}

        {!prompt && !response && !isLoading && <AIEmptyState />}
      </div>

      <div className="ai-slide-panel-footer">
        <span className="ai-slide-footer-note">Enter to generate</span>
        <span className="ai-slide-footer-note">Shift+Enter for a new line</span>
        <span className="ai-slide-footer-note">Esc to close</span>
      </div>
    </div>
  );
}
