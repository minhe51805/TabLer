import { Send, Copy } from "lucide-react";
import type { SqlRiskAnalysis } from "./AISlidePanelUtils";

interface AIResponseCardProps {
  response: string;
  responseRisk: SqlRiskAnalysis;
  onInsert: () => void;
  onCopy: () => void;
}

export function AIResponseCard({ response, responseRisk, onInsert, onCopy }: AIResponseCardProps) {
  return (
    <div className="ai-slide-response-card">
      <div className="ai-slide-response-head">
        <div className="ai-slide-response-copy">
          <label className="ai-slide-section-label">Generated SQL</label>
          <span className="ai-slide-response-note">Review it, then insert it into the editor.</span>
          {responseRisk.reason && (
            <span className={`ai-slide-response-note ${responseRisk.level === "dangerous" ? "text-[var(--warning)]" : ""}`}>
              {responseRisk.reason}
            </span>
          )}
        </div>

        <div className="ai-slide-response-actions">
          <button
            onClick={onInsert}
            className="ai-slide-inline-action primary"
            disabled={responseRisk.level === "dangerous"}
            title={responseRisk.level === "dangerous" ? "Blocked for potentially destructive SQL" : undefined}
          >
            <Send className="w-3.5 h-3.5" /> Insert
          </button>
          <button onClick={onCopy} className="ai-slide-inline-action">
            <Copy className="w-3.5 h-3.5" /> Copy
          </button>
        </div>
      </div>

      <pre className="ai-slide-response-code">{response}</pre>
    </div>
  );
}
