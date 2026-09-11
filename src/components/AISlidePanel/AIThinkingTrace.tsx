import { BrainCircuit } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";

interface AIThinkingTraceProps {
  /** The model's chain-of-thought text (accumulated `reasoning_delta`). */
  text: string;
  /** True while the answer is still generating: keep the panel open and stream
   *  the reasoning token by token. False once settled: collapse into a toggle. */
  streaming: boolean;
  copy: AIWorkspaceCopy;
}

/** Claude/ChatGPT-style live "thinking" trace shared by the conversation view
 *  and the workspace bubble. While the model streams its chain-of-thought the
 *  panel stays open and fills in token by token (auto scrolling to the freshest
 *  tokens); once the answer lands it collapses into a "Model reasoning" toggle
 *  so the thought stays available without dominating the turn. This replaces the
 *  old behaviour that stalled on a static "Thinking" pill and then dumped the
 *  whole reasoning in one block. */
export function AIThinkingTrace({ text, streaming, copy }: AIThinkingTraceProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest reasoning tokens in view as they stream in.
  useEffect(() => {
    if (!streaming) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text, streaming]);

  if (streaming) {
    return (
      <div className="ai-workspace-chat-reasoning is-streaming">
        <div className="ai-workspace-chat-reasoning-summary">
          <span className="ai-workspace-thinking-orb" aria-hidden="true" />
          <span className="ai-workspace-chat-reasoning-label">{copy.bubbleMeta.thinking}</span>
          <span className="ai-workspace-thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
        <div className="ai-workspace-chat-reasoning-body" ref={bodyRef}>
          <AIWorkspaceMarkdown className="ai-workspace-chat-reasoning-text" compact text={text} />
        </div>
      </div>
    );
  }

  return (
    <details className="ai-workspace-chat-reasoning">
      <summary className="ai-workspace-chat-reasoning-summary">
        <BrainCircuit className="w-3.5 h-3.5" />
        <span className="ai-workspace-chat-reasoning-label">{copy.modal.reasoningLabel}</span>
      </summary>
      <div className="ai-workspace-chat-reasoning-body">
        <AIWorkspaceMarkdown className="ai-workspace-chat-reasoning-text" compact text={text} />
      </div>
    </details>
  );
}
