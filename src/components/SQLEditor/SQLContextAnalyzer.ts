import type * as Monaco from "monaco-editor";

export interface SQLAnalysisContext {
  /** Detected SQL keyword context at cursor */
  context:
    | "SELECT"
    | "FROM"
    | "WHERE"
    | "JOIN"
    | "ON"
    | "ORDER BY"
    | "GROUP BY"
    | "HAVING"
    | "SET"
    | "VALUES"
    | "INSERT INTO"
    | "UPDATE"
    | "DELETE FROM"
    | "UNKNOWN";
  /** Table referenced by current clause (extracted from FROM/JOIN) */
  table: string | null;
  /** Alias for the current table */
  alias: string | null;
  /** Word at cursor position */
  word: string;
  /** Completion range for Monaco */
  range: Monaco.IRange;
  /** Whether cursor is after a JOIN or join keyword */
  isJoinContext: boolean;
  /** Whether cursor is after ON keyword */
  isOnContext: boolean;
  /** Whether cursor is inside an alias definition (AS alias) */
  isAliasDefinition: boolean;
}


/**
 * Analyzes the SQL text around the cursor position to determine:
 * - Which SQL clause the cursor is inside (SELECT, FROM, WHERE, etc.)
 * - Which table is currently in scope
 * - Any alias defined for that table
 */
export function analyzeSqlContext(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): SQLAnalysisContext {
  const word = model.getWordUntilPosition(position);
  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };

  const fullText = model.getValue();
  const offset = model.getOffsetAt(position);
  const textBefore = fullText.substring(0, offset);

  // Walk backward from cursor to find the current clause keyword
  const beforeCursor = textBefore.toUpperCase();

  let detectedContext: SQLAnalysisContext["context"] = "UNKNOWN";
  let isJoinContext = false;
  let isOnContext = false;
  let isAliasDefinition = false;

  // Split on statement boundaries and find the last complete clause
  const statementBoundaries = /(?:;|^|\n)/i;
  const afterLastBoundary = beforeCursor.split(statementBoundaries).pop() || "";

  // Check for ON clause
  const onMatch = afterLastBoundary.match(/\bON\b\s*$/i);
  if (onMatch) {
    detectedContext = "ON";
    isOnContext = true;
  }

  // Check for SET clause (UPDATE ... SET)
  if (!isOnContext) {
    const setMatch = afterLastBoundary.match(/\bSET\b\s*$/i);
    if (setMatch) {
      detectedContext = "SET";
    }
  }

  // Check for INSERT INTO
  if (!isOnContext && detectedContext === "UNKNOWN") {
    const insertMatch = afterLastBoundary.match(/\bINSERT\s+INTO\b\s*$/i);
    if (insertMatch) {
      detectedContext = "INSERT INTO";
    }
  }

  // Check for UPDATE
  if (!isOnContext && detectedContext === "UNKNOWN") {
    const updateMatch = afterLastBoundary.match(/\bUPDATE\b\s*$/i);
    if (updateMatch) {
      detectedContext = "UPDATE";
    }
  }

  // Check for DELETE FROM
  if (!isOnContext && detectedContext === "UNKNOWN") {
    const deleteMatch = afterLastBoundary.match(/\bDELETE\s+FROM\b\s*$/i);
    if (deleteMatch) {
      detectedContext = "DELETE FROM";
    }
  }

  // Check for VALUES
  if (!isOnContext && detectedContext === "UNKNOWN") {
    const valuesMatch = afterLastBoundary.match(/\bVALUES\b\s*$/i);
    if (valuesMatch) {
      detectedContext = "VALUES";
    }
  }

  // Check for JOIN keywords
  if (!isOnContext && detectedContext === "UNKNOWN") {
    const joinMatch = afterLastBoundary.match(
      /\b(LEFT\s+|RIGHT\s+|INNER\s+|OUTER\s+|CROSS\s+|FULL\s+)?JOIN\b\s*$/i
    );
    if (joinMatch) {
      detectedContext = "JOIN";
      isJoinContext = true;
    }
  }

  // Check for ORDER BY
  if (detectedContext === "UNKNOWN") {
    const orderMatch = afterLastBoundary.match(/\bORDER\s+BY\b\s*$/i);
    if (orderMatch) {
      detectedContext = "ORDER BY";
    }
  }

  // Check for GROUP BY
  if (detectedContext === "UNKNOWN") {
    const groupMatch = afterLastBoundary.match(/\bGROUP\s+BY\b\s*$/i);
    if (groupMatch) {
      detectedContext = "GROUP BY";
    }
  }

  // Check for HAVING
  if (detectedContext === "UNKNOWN") {
    const havingMatch = afterLastBoundary.match(/\bHAVING\b\s*$/i);
    if (havingMatch) {
      detectedContext = "HAVING";
    }
  }

  // Check for WHERE
  if (detectedContext === "UNKNOWN") {
    const whereMatch = afterLastBoundary.match(/\bWHERE\b\s*$/i);
    if (whereMatch) {
      detectedContext = "WHERE";
    }
  }

  // Check for FROM
  if (detectedContext === "UNKNOWN") {
    const fromMatch = afterLastBoundary.match(/\bFROM\b\s*$/i);
    if (fromMatch) {
      detectedContext = "FROM";
    }
  }

  // Check for SELECT (default clause)
  if (detectedContext === "UNKNOWN") {
    const selectMatch = afterLastBoundary.match(/\bSELECT\b\s*$/i);
    if (selectMatch) {
      detectedContext = "SELECT";
    }
  }

  // Extract table and alias from FROM/JOIN clauses
  let table: string | null = null;
  let alias: string | null = null;

  if (detectedContext === "FROM" || detectedContext === "JOIN") {
    // Extract the table name before FROM/JOIN keyword
    const clauseStart = afterLastBoundary.search(/\b(FROM|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL)\s*$/i);
    if (clauseStart >= 0) {
      const beforeClause = afterLastBoundary.substring(0, clauseStart);
      // Find the previous token (table name)
      const tokenMatch = beforeClause.match(/([\w.`"\[\]]+)\s*$/);
      if (tokenMatch) {
        table = tokenMatch[1].replace(/[`"\[\]]/g, "");
      }
    }
  }

  // Try to detect alias (AS alias or direct alias after table)
  if (table) {
    // Look for "table AS alias" or "table alias" after the table name in the clause
    const afterTable = afterLastBoundary.match(
      new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:AS\\s+)?([\\w]+)\\s*`, "i")
    );
    if (afterTable) {
      alias = afterTable[1];
      isAliasDefinition = true;
    }
  }

  return {
    context: detectedContext,
    table,
    alias,
    word: word.word,
    range,
    isJoinContext,
    isOnContext,
    isAliasDefinition,
  };
}

/**
 * Extracts all table names and their aliases currently referenced in the query.
 * Used to build column scope for SELECT/WHERE/ORDER BY etc.
 */
export function extractTableAliases(
  model: Monaco.editor.ITextModel
): Map<string, { table: string; alias: string }> {
  const text = model.getValue().toUpperCase();
  const result = new Map<string, { table: string; alias: string }>();

  // Regex to find FROM/JOIN clauses: table_name [AS] alias
  const fromJoinPattern = /\b(FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|OUTER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN)\s+([`"'\[]?[\w]+[`"'\]]?)\s*(?:AS\s+)?([`"'\[]?[\w]+[`"'\]]?)?/gi;

  let match: RegExpExecArray | null;
  while ((match = fromJoinPattern.exec(text)) !== null) {
    const tableName = match[2].replace(/[`"'\[\]]/g, "");
    const alias = match[3]?.replace(/[`"'\[\]]/g, "") || tableName;
    if (alias) {
      result.set(alias.toLowerCase(), { table: tableName, alias });
    }
  }

  return result;
}

/**
 * Determines which tables are in scope at the current position for column completions.
 * Returns an array of { table, alias } pairs.
 */
export function getTablesInScope(
  model: Monaco.editor.ITextModel,
  _position: Monaco.Position
): Array<{ table: string; alias: string }> {
  const tableAliases = extractTableAliases(model);
  return Array.from(tableAliases.values());
}
