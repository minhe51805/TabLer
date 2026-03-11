import { useState, useRef } from "react";
import { Loader2, Sparkles, Bot, X, Send, Copy } from "lucide-react";
import { useAppStore } from "../../stores/appStore";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function AISlidePanel({ isOpen, onClose }: Props) {
  const { askAI, aiConfigs, tables, getTableStructure, fetchTables, activeConnectionId: connectionId, currentDatabase } = useAppStore();
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleGenerate = async () => {
    if (!prompt.trim() || !connectionId) {
      setError("Please connect to a database first.");
      return;
    }

    const activeProvider = aiConfigs.find(c => c.is_enabled);
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

      // Use all tables from store - get schema for each (limit to 30 to avoid slowdowns)
      const latestTables = useAppStore.getState().tables;
      const tablesToFetch = latestTables.slice(0, 30);
      const tableSchemas = await Promise.all(
        tablesToFetch.map(async (t) => {
          try {
            const structure = await getTableStructure(connectionId, t.name, currentDatabase || undefined);
            const columns = structure.columns.map((c: any) => c.name + " " + c.data_type).join(", ");
            return "Table " + t.name + " (" + columns + ")";
          } catch {
            return "Table " + t.name;
          }
        })
      );

      const context = "Database: " + (currentDatabase || "Default") + "\n\nIMPORTANT - Only use these tables in your SQL query:\n" + tableSchemas.join("\n") + "\n\nDo NOT use any table that is not listed above. If you need a table that doesn't exist, ask the user to create it first.";
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[400px] bg-[var(--bg-secondary)] border-l border-[var(--border-color)] shadow-xl flex flex-col z-50 animate-in slide-in-from-right duration-200">
      <div className="flex items-center justify-between !px-4 !py-4 bg-[rgba(255,255,255,0.03)] border-b border-[var(--border-color)]">
        <div className="flex items-center !gap-3">
          <Sparkles className="!w-4 !h-4 text-[var(--accent)]" />
          <span className="text-[13px] font-semibold">Ask AI Assistant</span>
        </div>
        <button onClick={onClose} className="!p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.1)]">
          <X className="!w-4 !h-4 text-[var(--text-muted)]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto !p-4 !space-y-4">
        <div className="!space-y-2">
          <div className="!pb-1">
            <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Your Request</label>

          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI to generate or modify SQL... (e.g. 'Create users table')"
            className="w-full bg-[rgba(0,0,0,0.2)] border border-white/10 rounded-md !p-3 text-[13px] min-h-[100px] outline-none focus:border-[var(--accent)]/50 resize-none placeholder:text-[var(--text-muted)]"
            autoFocus
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-muted)]">Press Enter to generate</span>
            <button onClick={handleGenerate} disabled={isLoading || !prompt.trim()} className="btn btn-primary !px-4 !py-1.5 h-auto text-[12px] flex items-center gap-2">
              {isLoading ? <Loader2 className="!w-3.5 !h-3.5 animate-spin" /> : <Bot className="!w-3.5 !h-3.5" />}
              {isLoading ? "Generating..." : "Generate SQL"}
            </button>
          </div>
        </div>

        {error && (
          <div className="!p-3 bg-[var(--error)]/10 border border-[var(--error)]/30 rounded-md">
            <p className="text-[12px] text-[var(--error)]">{error}</p>
          </div>
        )}

        {response && (
          <div className="!space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Generated SQL</label>
              <div className="flex items-center gap-3">
                <button onClick={handleInsert} className="text-[11px] text-[var(--accent)] hover:underline flex items-center !gap-1">
                  <Send className="!w-3 !h-3" /> Insert
                </button>
                <button onClick={handleCopy} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center !gap-1">
                  <Copy className="!w-3 !h-3" /> Copy
                </button>
              </div>
            </div>
            <pre className="!p-4 bg-[var(--bg-surface)] border border-white/10 rounded-md text-[13px] font-mono text-[var(--text-primary)] whitespace-pre-wrap overflow-x-auto">{response}</pre>
          </div>
        )}

        {!prompt && !response && !isLoading && (
          <div className="flex flex-col items-center justify-center !py-12 text-center">
            <Bot className="!w-12 !h-12 text-[var(--accent)] opacity-40 !mb-4" />
            <p className="text-[13px] text-[var(--text-muted)]">Describe the SQL you want to create or modify</p>
            <p className="text-[11px] text-[var(--text-muted)] !mt-2 opacity-70">e.g., "Create a users table with name and email"</p>
          </div>
        )}
      </div>

      <div className="!px-4 !py-2 bg-[rgba(255,255,255,0.02)] border-t border-[var(--border-color)]">
        <span className="text-[10px] text-[var(--text-muted)]">Press Esc to close</span>
      </div>
    </div>
  );
}
