import type { AIProviderConfig } from "../../types/ai";

interface AIContextPanelProps {
  currentDatabase: string | null;
  tableContextCount: number;
  activeProvider: AIProviderConfig | undefined;
}

export function AIContextPanel({ currentDatabase, tableContextCount, activeProvider }: AIContextPanelProps) {
  return (
    <div className="ai-slide-context-strip">
      <span className="ai-slide-context-pill accent">{currentDatabase || "No database"}</span>
      <span className="ai-slide-context-pill">
        {tableContextCount} {tableContextCount === 1 ? "table" : "tables"}
      </span>
      <span className={`ai-slide-context-pill ${activeProvider?.allow_schema_context ? "success" : "warning"}`}>
        {activeProvider?.allow_schema_context ? "Schema shared" : "Schema private"}
      </span>
      <span className={`ai-slide-context-pill ${activeProvider ? "success" : "warning"}`}>
        {activeProvider ? activeProvider.name : "No provider"}
      </span>
    </div>
  );
}
