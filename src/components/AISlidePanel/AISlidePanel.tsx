import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, Bot, X, Send, Copy } from "lucide-react";
import { useAppStore } from "../../stores/appStore";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const PROMPT_IDEAS = [
  {
    title: "Create table",
    prompt: "Create a users table with id, name, email, role, and created_at.",
  },
  {
    title: "Alter schema",
    prompt: "Add a last_login_at column to the users table and backfill it with CURRENT_TIMESTAMP.",
  },
  {
    title: "Write query",
    prompt: "Write a query that shows the top 10 users by order count in the last 30 days.",
  },
];

const MAX_TABLE_NAMES_IN_CONTEXT = 40;
const MAX_SCHEMA_SUMMARIES = 8;
const MAX_COLUMNS_PER_SUMMARY = 12;

function rankTableForPrompt(promptText: string, tableName: string) {
  const normalizedPrompt = promptText.toLowerCase();
  const normalizedTable = tableName.toLowerCase();
  const tokens = normalizedTable.split(/[^a-z0-9]+/).filter((token) => token.length > 1);

  let score = normalizedPrompt.includes(normalizedTable) ? 10 : 0;
  for (const token of tokens) {
    if (normalizedPrompt.includes(token)) {
      score += token.length >= 5 ? 4 : 2;
    }
  }

  return score;
}

function pickRelevantTables(promptText: string, tables: Array<{ name: string }>) {
  const ranked = tables
    .map((table) => ({
      table,
      score: rankTableForPrompt(promptText, table.name),
    }))
    .sort((left, right) => right.score - left.score || left.table.name.localeCompare(right.table.name));

  const matched = ranked.filter((item) => item.score > 0).slice(0, MAX_SCHEMA_SUMMARIES);
  if (matched.length === MAX_SCHEMA_SUMMARIES) {
    return matched.map((item) => item.table);
  }

  const usedNames = new Set(matched.map((item) => item.table.name));
  const fallbacks = ranked
    .filter((item) => !usedNames.has(item.table.name))
    .slice(0, MAX_SCHEMA_SUMMARIES - matched.length)
    .map((item) => item.table);

  return [...matched.map((item) => item.table), ...fallbacks];
}

function summarizeStructure(tableName: string, columns: Array<{ name: string; data_type: string }>) {
  if (columns.length === 0) {
    return `Table ${tableName}`;
  }

  const preview = columns
    .slice(0, MAX_COLUMNS_PER_SUMMARY)
    .map((column) => `${column.name} ${column.data_type}`)
    .join(", ");
  const remaining = columns.length - MAX_COLUMNS_PER_SUMMARY;

  return remaining > 0
    ? `Table ${tableName} (${preview}, +${remaining} more columns)`
    : `Table ${tableName} (${preview})`;
}

export function AISlidePanel({ isOpen, onClose }: Props) {
  const { askAI, aiConfigs, tables, getTableStructure, fetchTables, activeConnectionId: connectionId, currentDatabase } = useAppStore();
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const schemaSummaryCacheRef = useRef(new Map<string, string>());
  const activeProvider = aiConfigs.find((c) => c.is_enabled);
  const tableContextCount = tables?.length || 0;

  useEffect(() => {
    schemaSummaryCacheRef.current.clear();
  }, [connectionId, currentDatabase]);

  const handleGenerate = async () => {
    if (!prompt.trim() || !connectionId) {
      setError("Please connect to a database first.");
      return;
    }

    if (!activeProvider) {
      setError("No AI provider enabled. Please configure an AI provider in Settings first.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Check if tables are loaded, if not, try to fetch them first
      if (!tables || tables.length === 0) {
        if (connectionId && currentDatabase) {
          await fetchTables(connectionId, currentDatabase);
        }
        // If still no tables after fetch, show error
        const currentTables = useAppStore.getState().tables;
        if (!currentTables || currentTables.length === 0) {
          setError("No tables found. Please make sure you are connected to a database with tables.");
          setIsLoading(false);
          return;
        }
      }

      // Keep broad table awareness, but only fetch deep schema for a small relevant subset.
      const latestTables = useAppStore.getState().tables;
      const availableTableNames = latestTables
        .map((table) => table.name)
        .slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
      const tablesToFetch = pickRelevantTables(prompt, latestTables);
      const tableSchemas = await Promise.all(
        tablesToFetch.map(async (t) => {
          const cacheKey = `${connectionId}:${currentDatabase || "default"}:${t.name}`;
          const cachedSummary = schemaSummaryCacheRef.current.get(cacheKey);
          if (cachedSummary) {
            return cachedSummary;
          }

          try {
            const structure = await getTableStructure(connectionId, t.name, currentDatabase || undefined);
            const summary = summarizeStructure(t.name, structure.columns);
            schemaSummaryCacheRef.current.set(cacheKey, summary);
            return summary;
          } catch {
            const summary = "Table " + t.name;
            schemaSummaryCacheRef.current.set(cacheKey, summary);
            return summary;
          }
        })
      );

      const context = [
        `Database: ${currentDatabase || "Default"}`,
        "",
        `Available tables (${latestTables.length}): ${availableTableNames.join(", ")}${latestTables.length > MAX_TABLE_NAMES_IN_CONTEXT ? ", ..." : ""}`,
        "",
        "Detailed schemas for the most relevant tables:",
        tableSchemas.join("\n"),
        "",
        "Only use tables from the available list above. If a needed table is missing, ask the user to create it first.",
      ].join("\n");
      let aiResponse = await askAI(activeProvider.id, prompt, context);

      // Extract SQL - try multiple approaches
      let sqlResult = aiResponse;

      // 1. Try markdown code block
      const codeBlock = aiResponse.match(/```sql?([\s\S]*?)```/i);
      if (codeBlock && codeBlock[1]) {
        sqlResult = codeBlock[1].trim();
      } else {
        // 2. Find first SQL keyword and take everything from there
        const keywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'WITH'];
        let foundIndex = -1;
        for (const kw of keywords) {
          const idx = aiResponse.toLowerCase().indexOf(kw.toLowerCase());
          if (idx !== -1 && (foundIndex === -1 || idx < foundIndex)) {
            foundIndex = idx;
          }
        }

        if (foundIndex !== -1) {
          sqlResult = aiResponse.substring(foundIndex).trim();
          // Remove any trailing explanations (lines that don't start with SQL keywords or common SQL words)
          const lines = sqlResult.split('\n');
          const validContinuations = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'SET', 'VALUES', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'WITH', 'AS', 'INTO', 'TABLE', 'INDEX', 'VIEW', 'NULL', 'NOT', 'EXISTS', 'LIKE', 'BETWEEN', 'IN', 'IS'];
          const cleanedLines: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim().toUpperCase();
            if (validContinuations.some(v => trimmed.startsWith(v))) {
              cleanedLines.push(line);
            } else if (cleanedLines.length > 0) {
              // Once we have SQL, only include lines that look like SQL
              if (trimmed === '' || /^[A-Z_]+$/.test(trimmed)) {
                continue; // Skip standalone keywords
              }
              break;
            }
          }
          sqlResult = cleanedLines.join('\n').trim();
        }
      }

      // Validate
      const upperResult = sqlResult.toUpperCase().trim();
      const validStarts = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'WITH'];
      const hasValid = validStarts.some(s => upperResult.startsWith(s));

      if (!hasValid) {
        setError("Invalid SQL response from AI. Try again.");
        setIsLoading(false);
        return;
      }

      setResponse(sqlResult);
    } catch (e) {
      setError("AI Error: " + String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      handleGenerate();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  const handleCopy = () => {
    if (response) navigator.clipboard.writeText(response);
  };

  const handleInsert = () => {
    if (response) {
      window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql: response } }));
    }
  };

  const handleUseSuggestion = (nextPrompt: string) => {
    setPrompt(nextPrompt);
    setError(null);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextPrompt.length, nextPrompt.length);
    });
  };

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
        <div className="ai-slide-context-strip">
          <span className="ai-slide-context-pill accent">
            {currentDatabase || "No database"}
          </span>
          <span className="ai-slide-context-pill">
            {tableContextCount} {tableContextCount === 1 ? "table" : "tables"}
          </span>
          <span className={`ai-slide-context-pill ${activeProvider ? "success" : "warning"}`}>
            {activeProvider ? activeProvider.name : "No provider"}
          </span>
        </div>

        <div className="ai-slide-composer-card">
          <div className="ai-slide-composer-head">
            <label className="ai-slide-section-label">Your Request</label>
            <span className="ai-slide-hotkey">Enter to generate</span>
          </div>

          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the SQL you want to create, modify, or debug..."
            className="ai-slide-textarea"
            autoFocus
          />

          <div className="ai-slide-composer-footer">
            <div className="ai-slide-helper-copy">
              <span className="ai-slide-helper-title">Context-aware</span>
              <span className="ai-slide-helper-text">
                Uses your current schema so the output stays grounded in real tables.
              </span>
            </div>

            <button
              onClick={handleGenerate}
              disabled={isLoading || !prompt.trim()}
              className="btn btn-primary ai-slide-submit-btn"
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
              {isLoading ? "Generating..." : "Generate SQL"}
            </button>
          </div>
        </div>

        {error && (
          <div className="ai-slide-alert error">
            <p>{error}</p>
          </div>
        )}

        {!prompt && !response && !isLoading && (
          <div className="ai-slide-suggestions-card">
            <div className="ai-slide-suggestions-head">
              <span className="ai-slide-section-label">Quick Starts</span>
              <span className="ai-slide-suggestions-note">Tap to fill the prompt</span>
            </div>

            <div className="ai-slide-suggestions-grid">
              {PROMPT_IDEAS.map((idea) => (
                <button
                  key={idea.title}
                  type="button"
                  className="ai-slide-suggestion-btn"
                  onClick={() => handleUseSuggestion(idea.prompt)}
                >
                  <span className="ai-slide-suggestion-title">{idea.title}</span>
                  <span className="ai-slide-suggestion-copy">{idea.prompt}</span>
                </button>
              ))}
            </div>
          </div>
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
          <div className="ai-slide-response-card">
            <div className="ai-slide-response-head">
              <div className="ai-slide-response-copy">
                <label className="ai-slide-section-label">Generated SQL</label>
                <span className="ai-slide-response-note">Review it, then insert it into the editor.</span>
              </div>

              <div className="ai-slide-response-actions">
                <button onClick={handleInsert} className="ai-slide-inline-action primary">
                  <Send className="w-3.5 h-3.5" /> Insert
                </button>
                <button onClick={handleCopy} className="ai-slide-inline-action">
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>
            </div>

            <pre className="ai-slide-response-code">{response}</pre>
          </div>
        )}

        {!prompt && !response && !isLoading && (
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
        )}
      </div>

      <div className="ai-slide-panel-footer">
        <span className="ai-slide-footer-note">Enter to generate</span>
        <span className="ai-slide-footer-note">Shift+Enter for a new line</span>
        <span className="ai-slide-footer-note">Esc to close</span>
      </div>
    </div>
  );
}
