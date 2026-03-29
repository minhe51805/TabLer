import { Bot } from "lucide-react";

export function AIEmptyState() {
  return (
    <div className="ai-workspace-chat-empty">
      <div className="ai-workspace-chat-empty-illustration">
        <Bot className="w-5 h-5" />
      </div>
      <p className="ai-workspace-chat-empty-title">Describe the SQL you need</p>
      <p className="ai-workspace-chat-empty-text">
        Try asking for a new table, an index, a reporting query, or help changing an existing schema.
      </p>
    </div>
  );
}
