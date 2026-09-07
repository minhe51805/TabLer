import { Bot } from "lucide-react";

export function AIEmptyState() {
  return (
    <div className="ai-workspace-chat-empty">
      <div className="ai-workspace-chat-empty-illustration">
        <Bot className="w-5 h-5" />
      </div>
      <p className="ai-workspace-chat-empty-title">Ask for help, ideas, or SQL</p>
      <p className="ai-workspace-chat-empty-text">
        Try brainstorming, drafting content, explaining code, or asking for grounded database help when you need workspace context.
      </p>
    </div>
  );
}
