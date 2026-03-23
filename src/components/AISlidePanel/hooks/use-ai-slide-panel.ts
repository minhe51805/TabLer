import { useRef, useState, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../stores/appStore";
import {
  pickRelevantTables,
  summarizeStructure,
  analyzeGeneratedSql,
  type SqlRiskAnalysis,
  MAX_TABLE_NAMES_IN_CONTEXT,
} from "../AISlidePanelUtils";

export function useAISlidePanel({
  isOpen: _isOpen,
  initialPrompt = "",
  initialPromptNonce = 0,
}: {
  isOpen: boolean;
  initialPrompt?: string;
  initialPromptNonce?: number;
}) {
  const { askAI, aiConfigs, tables, getTableStructure, fetchTables, activeConnectionId: connectionId, currentDatabase } =
    useAppStore(
      useShallow((state) => ({
        askAI: state.askAI,
        aiConfigs: state.aiConfigs,
        tables: state.tables,
        getTableStructure: state.getTableStructure,
        fetchTables: state.fetchTables,
        activeConnectionId: state.activeConnectionId,
        currentDatabase: state.currentDatabase,
      }))
    );

  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [responseRisk, setResponseRisk] = useState<SqlRiskAnalysis>({ level: "safe", reason: null });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const schemaSummaryCacheRef = useRef(new Map<string, string>());
  const requestIdRef = useRef(0);

  const activeProvider = aiConfigs.find((c) => c.is_enabled);
  const tableContextCount = tables?.length || 0;

  useEffect(() => {
    schemaSummaryCacheRef.current.clear();
  }, [connectionId, currentDatabase]);

  useEffect(() => {
    if (!initialPromptNonce || !initialPrompt.trim()) return;
    setPrompt(initialPrompt);
    setError(null);
    setResponse(null);
    setResponseRisk({ level: "safe", reason: null });
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(initialPrompt.length, initialPrompt.length);
    });
  }, [initialPrompt, initialPromptNonce]);

  const handleGenerate = useCallback(async () => {
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
    setResponse(null);
    setResponseRisk({ level: "safe", reason: null });
    const requestId = ++requestIdRef.current;

    try {
      let latestTables = useAppStore.getState().tables;

      if (!latestTables || latestTables.length === 0) {
        if (connectionId && currentDatabase) {
          await fetchTables(connectionId, currentDatabase);
        }
        if (requestId !== requestIdRef.current) return;
        latestTables = useAppStore.getState().tables;
        if (!latestTables || latestTables.length === 0) {
          setError("No tables found. Please make sure you are connected to a database with tables.");
          setIsLoading(false);
          return;
        }
      }

      let context = "";
      if (activeProvider.allow_schema_context) {
        const availableTableNames = latestTables.map((t) => t.name).slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
        const tablesToFetch = pickRelevantTables(prompt, latestTables);
        const tableSchemas = await Promise.all(
          tablesToFetch.map(async (t) => {
            const cacheKey = `${connectionId}:${currentDatabase || "default"}:${t.name}`;
            const cachedSummary = schemaSummaryCacheRef.current.get(cacheKey);
            if (cachedSummary) return cachedSummary;
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
        if (requestId !== requestIdRef.current) return;

        context = [
          `Database: ${currentDatabase || "Default"}`,
          "",
          `Available tables (${latestTables.length}): ${availableTableNames.join(", ")}${latestTables.length > MAX_TABLE_NAMES_IN_CONTEXT ? ", ..." : ""}`,
          "",
          "Detailed schemas for the most relevant tables:",
          tableSchemas.join("\n"),
          "",
          "Only use tables from the available list above. If a needed table is missing, ask the user to create it first.",
        ].join("\n");
      }

      const aiResponse = await askAI(prompt, context, "panel");
      if (requestId !== requestIdRef.current) return;

      // Extract SQL
      let sqlResult = aiResponse;
      const codeBlock = aiResponse.match(/```sql?([\s\S]*?)```/i);
      if (codeBlock && codeBlock[1]) {
        sqlResult = codeBlock[1].trim();
      } else {
        const keywords = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH"];
        let foundIndex = -1;
        for (const kw of keywords) {
          const idx = aiResponse.toLowerCase().indexOf(kw.toLowerCase());
          if (idx !== -1 && (foundIndex === -1 || idx < foundIndex)) {
            foundIndex = idx;
          }
        }
        if (foundIndex !== -1) {
          sqlResult = aiResponse.substring(foundIndex).trim();
          const validContinuations = [
            "SELECT", "FROM", "WHERE", "AND", "OR", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
            "ON", "SET", "VALUES", "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION",
            "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH", "AS", "INTO",
            "TABLE", "INDEX", "VIEW", "NULL", "NOT", "EXISTS", "LIKE", "BETWEEN", "IN", "IS",
          ];
          const lines = sqlResult.split("\n");
          const cleanedLines: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim().toUpperCase();
            if (validContinuations.some((v) => trimmed.startsWith(v))) {
              cleanedLines.push(line);
            } else if (cleanedLines.length > 0) {
              if (trimmed === "" || /^[A-Z_]+$/.test(trimmed)) continue;
              break;
            }
          }
          sqlResult = cleanedLines.join("\n").trim();
        }
      }

      const upperResult = sqlResult.toUpperCase().trim();
      const validStarts = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH"];
      if (!validStarts.some((s) => upperResult.startsWith(s))) {
        setError("Invalid SQL response from AI. Try again.");
        setIsLoading(false);
        return;
      }

      setResponse(sqlResult);
      setResponseRisk(analyzeGeneratedSql(sqlResult));
    } catch (e) {
      if (requestId === requestIdRef.current) {
        setError("AI Error: " + String(e));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [prompt, connectionId, activeProvider, currentDatabase, fetchTables, getTableStructure, askAI]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      void handleGenerate();
    }
  }, [handleGenerate]);

  const handleCopy = useCallback(() => {
    if (response) navigator.clipboard.writeText(response);
  }, [response]);

  const handleInsert = useCallback(() => {
    if (response) {
      if (responseRisk.level === "dangerous") {
        setError(responseRisk.reason || "Potentially destructive SQL cannot be inserted directly.");
        return;
      }
      window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql: response } }));
    }
  }, [response, responseRisk]);

  const handleUseSuggestion = useCallback((nextPrompt: string) => {
    setPrompt(nextPrompt);
    setError(null);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextPrompt.length, nextPrompt.length);
    });
  }, []);

  return {
    prompt,
    setPrompt,
    response,
    responseRisk,
    isLoading,
    error,
    textareaRef,
    activeProvider,
    tableContextCount,
    currentDatabase,
    handleGenerate,
    handleKeyDown,
    handleCopy,
    handleInsert,
    handleUseSuggestion,
  };
}
