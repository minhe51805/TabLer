/**
 * Learning-proposal cards (P9).
 *
 * What a finished run could teach, offered — not applied. Each card writes to
 * exactly one place (per-connection memory, a global guardrail rule, or a skill)
 * and only when the user presses its button; nothing here executes SQL, so a
 * learned artifact can never act on the database by itself.
 *
 * On success the card is retired (the offer is spent) and the outcome is
 * announced with the path that was written, so "saved" is checkable rather than
 * merely claimed. On failure the card stays, now carrying the requirement that
 * the user decide what to do about it.
 */

import { useMemo, useState } from "react";
import "../../styles/ai-learnings.css";
import {
  useAgentLearningStore,
  type ScopedLearningProposal,
} from "../../stores/agent-learning-store";
import { emitAppToast } from "../../utils/app-toast";
import { invokeMutation } from "../../utils/tauri-utils";
import { applyLearningProposal } from "./ai-agent-learning";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";

interface AIAgentLearningsProps {
  copy: AIWorkspaceCopy;
  /** Database scope the offers must belong to (`buildInsightScope` key). */
  scope: string;
}

export function AIAgentLearnings({ copy, scope }: AIAgentLearningsProps) {
  const entries = useAgentLearningStore((state) => state.proposals);
  const dismissLearning = useAgentLearningStore((state) => state.dismissLearning);
  const clearLearnings = useAgentLearningStore((state) => state.clearLearnings);
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);
  const [failedIds, setFailedIds] = useState<readonly string[]>([]);
  const visible = useMemo(() => entries.filter((entry) => entry.scope === scope), [entries, scope]);

  const labelFor = (entry: ScopedLearningProposal): string => {
    if (entry.proposal.kind === "memory") return copy.learnings.saveMemory;
    if (entry.proposal.kind === "rule") return copy.learnings.saveRule;
    return copy.learnings.saveSkill;
  };

  const approve = async (entry: ScopedLearningProposal) => {
    const id = entry.proposal.id;
    setSavingIds((current) => [...current, id]);
    setFailedIds((current) => current.filter((value) => value !== id));
    try {
      const path = await applyLearningProposal(entry.proposal, entry.target, (command, args) =>
        invokeMutation(command, args),
      );
      emitAppToast({ title: copy.learnings.saved, description: path, tone: "success" });
      dismissLearning(id);
    } catch (errorValue) {
      emitAppToast({
        title: copy.learnings.failed,
        description: errorValue instanceof Error ? errorValue.message : String(errorValue),
        tone: "error",
      });
      setFailedIds((current) => [...current, id]);
    } finally {
      setSavingIds((current) => current.filter((value) => value !== id));
    }
  };

  if (visible.length === 0) return null;
  return (
    <section className="ai-learnings-strip" data-testid="ai-learnings-strip">
      <div className="ai-learnings-header">
        <span className="ai-learnings-title">{copy.learnings.title}</span>
        <button
          type="button"
          className="ai-learnings-clear"
          title={copy.learnings.clearAll}
          onClick={clearLearnings}
        >
          {copy.learnings.clearAll}
        </button>
      </div>
      <ul className="ai-learnings-list">
        {visible.map((entry) => {
          const id = entry.proposal.id;
          const isSaving = savingIds.includes(id);
          const hasFailed = failedIds.includes(id);
          return (
            <li
              key={`${entry.scope}::${id}`}
              className="ai-learnings-card"
              data-learning-kind={entry.proposal.kind}
            >
              <span className="ai-learnings-card-title">{entry.proposal.title}</span>
              <p className="ai-learnings-card-rationale">{entry.proposal.rationale}</p>
              {entry.proposal.evidenceSql ? (
                <code className="ai-learnings-evidence" title={entry.proposal.evidenceSql}>
                  {entry.proposal.evidenceSql}
                </code>
              ) : null}
              <div className="ai-learnings-actions">
                <button
                  type="button"
                  className="ai-learnings-action"
                  disabled={isSaving}
                  onClick={() => void approve(entry)}
                >
                  {isSaving ? copy.learnings.saving : labelFor(entry)}
                </button>
                <button
                  type="button"
                  className="ai-learnings-action"
                  onClick={() => dismissLearning(id)}
                >
                  {copy.learnings.dismiss}
                </button>
                {hasFailed ? (
                  <span className="ai-learnings-status">{copy.learnings.failed}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
