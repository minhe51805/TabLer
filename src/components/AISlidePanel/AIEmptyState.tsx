import { Bot } from "lucide-react";

export function AIEmptyState() {
  return (
    <div className="ai-slide-empty-card">
      <div className="ai-slide-empty-icon">
        <Bot className="w-6 h-6" />
      </div>
      <div className="ai-slide-empty-copy">
        <p className="ai-slide-empty-title">Describe the SQL you need</p>
        <p className="ai-slide-empty-text">
          Try asking for a new table, an index, a reporting query, or help changing an existing schema.
        </p>
      </div>
    </div>
  );
}
