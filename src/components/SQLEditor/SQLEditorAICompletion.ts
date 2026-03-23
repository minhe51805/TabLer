import { useAppStore } from "../../stores/appStore";
import { devLogError } from "../../utils/logger";
import {
  isTrustedInlineCompletionConnection,
  normalizeInlineSuggestion,
  INLINE_COMPLETION_CACHE_MS,
  INLINE_COMPLETION_MIN_INTERVAL_MS,
  INLINE_COMPLETION_TABLE_LIMIT,
  MAX_DAILY_INLINE_COMPLETIONS,
} from "./SQLEditorUtils";

export function registerInlineAICompletionProvider(
  monaco: any,
  connectionId: string,
  inlineCompletionCacheRef: React.MutableRefObject<{ key: string; value: string; timestamp: number } | null>,
  inlineCompletionInFlightRef: React.MutableRefObject<{ key: string; promise: Promise<string> } | null>,
  lastInlineCompletionAtRef: React.MutableRefObject<number>,
  dailyInlineCompletionRef: React.MutableRefObject<{ count: number; date: string }>
): { dispose: () => void } {
  return monaco.languages.registerInlineCompletionsProvider("sql", {
    provideInlineCompletions: async (model: any, position: any, _context: any, _token: any) => {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      if (textUntilPosition.trim().length < 5) return { items: [] };

      const activeProvider = useAppStore.getState().aiConfigs.find((c) => c.is_enabled);
      if (!activeProvider) return { items: [] };
      if (!activeProvider.allow_inline_completion) return { items: [] };

      const activeConnection = useAppStore.getState().connections.find((c) => c.id === connectionId);
      if (!isTrustedInlineCompletionConnection(activeConnection)) return { items: [] };

      const dbName = useAppStore.getState().currentDatabase || "Default";
      const completionKey = `${dbName}:${textUntilPosition.trim()}`;

      // Cache check
      const cachedSuggestion = inlineCompletionCacheRef.current;
      if (
        cachedSuggestion &&
        cachedSuggestion.key === completionKey &&
        Date.now() - cachedSuggestion.timestamp < INLINE_COMPLETION_CACHE_MS
      ) {
        return cachedSuggestion.value
          ? { items: [{ insertText: cachedSuggestion.value, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
          : { items: [] };
      }

      // In-flight check
      const inFlightSuggestion = inlineCompletionInFlightRef.current;
      if (inFlightSuggestion?.key === completionKey) {
        const suggestion = await inFlightSuggestion.promise;
        return suggestion
          ? { items: [{ insertText: suggestion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
          : { items: [] };
      }

      // Rate-limit check
      if (Date.now() - lastInlineCompletionAtRef.current < INLINE_COMPLETION_MIN_INTERVAL_MS) {
        return { items: [] };
      }

      // Daily cap check
      const today = new Date().toDateString();
      if (dailyInlineCompletionRef.current.date !== today) {
        dailyInlineCompletionRef.current = { count: 0, date: today };
      }
      if (dailyInlineCompletionRef.current.count >= MAX_DAILY_INLINE_COMPLETIONS) {
        return { items: [] };
      }

      lastInlineCompletionAtRef.current = Date.now();
      dailyInlineCompletionRef.current.count += 1;

      try {
        const tableNameList = activeProvider.allow_schema_context
          ? useAppStore.getState().tables.slice(0, INLINE_COMPLETION_TABLE_LIMIT).map((t) => t.name).join(", ")
          : "";

        const dbContext = activeProvider.allow_schema_context
          ? `Database: ${dbName}\nAvailable Tables: ${tableNameList}\nProvide ONLY the raw SQL code completion. Do not add quotes, markdown, or explanations.`
          : "";

        const prompt = `Complete this SQL query (return only the remaining code):\n${textUntilPosition}`;

        const requestPromise = useAppStore
          .getState()
          .askAI(prompt, dbContext, "inline")
          .then((response) => normalizeInlineSuggestion(response, textUntilPosition))
          .finally(() => {
            if (inlineCompletionInFlightRef.current?.key === completionKey) {
              inlineCompletionInFlightRef.current = null;
            }
          });

        inlineCompletionInFlightRef.current = { key: completionKey, promise: requestPromise };

        const suggestion = await requestPromise;
        inlineCompletionCacheRef.current = { key: completionKey, value: suggestion, timestamp: Date.now() };

        if (suggestion) {
          return { items: [{ insertText: suggestion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
        }
      } catch (e) {
        devLogError("AI Completion error", e);
      }
      return { items: [] };
    },
    freeInlineCompletions: () => {},
  });
}
