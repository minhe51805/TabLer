import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AIProviderConfig } from "../../types/ai";

interface AIContextPanelProps {
  currentDatabase: string | null;
  tableContextCount: number;
  activeProvider: AIProviderConfig | undefined;
}

export function AIContextPanel({ currentDatabase, tableContextCount, activeProvider }: AIContextPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className={`ai-workspace-context-strip ${!isExpanded ? "is-collapsed" : ""}`}>
      <div
        className="ai-workspace-context-header"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
      >
        <span className="ai-workspace-context-label">Context</span>
        <ChevronDown className={`ai-workspace-context-toggle ${isExpanded ? "expanded" : "collapsed"}`} size={12} />
      </div>

      {isExpanded && (
        <div className="ai-workspace-context-pills">
          <span className="ai-workspace-pill accent">{currentDatabase || "No database"}</span>
          <span className="ai-workspace-pill">
            {tableContextCount} {tableContextCount === 1 ? "table" : "tables"}
          </span>
          <span className={`ai-workspace-pill ${activeProvider?.allow_schema_context ? "success" : "warning"}`}>
            {activeProvider?.allow_schema_context ? "Schema shared" : "Schema private"}
          </span>
          <span className={`ai-workspace-pill ${activeProvider ? "success" : "warning"}`}>
            {activeProvider ? activeProvider.name : "No provider"}
          </span>
        </div>
      )}
    </div>
  );
}
