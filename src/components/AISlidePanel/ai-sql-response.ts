import type { QueryResult } from "../../types";

const SQL_START_KEYWORDS = ["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "PRAGMA", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "WITH"];

export function isLikelySqlOnlyResponse(aiResponse: string) {
  const extractedSql = extractSqlFromResponse(aiResponse);
  if (!extractedSql) return false;

  const normalizedResponse = aiResponse.replace(/```sql?/gi, "").replace(/```/g, "").trim();
  if (!normalizedResponse) return false;

  const remainder = normalizedResponse.replace(extractedSql, "").replace(/\s+/g, " ").trim();
  return remainder.length < 40;
}

export function stripLeadingSqlComments(sql: string) {
  let remaining = sql.trimStart();

  while (remaining.length > 0) {
    if (remaining.startsWith("--") || remaining.startsWith("#")) {
      const nextNewline = remaining.indexOf("\n");
      remaining = nextNewline >= 0 ? remaining.slice(nextNewline + 1).trimStart() : "";
      continue;
    }

    if (remaining.startsWith("/*")) {
      const commentEnd = remaining.indexOf("*/");
      if (commentEnd < 0) return "";
      remaining = remaining.slice(commentEnd + 2).trimStart();
      continue;
    }

    break;
  }

  return remaining.trimStart();
}

export function hasSqlStartKeyword(sql: string) {
  const normalized = stripLeadingSqlComments(sql).toUpperCase().trim();
  return normalized.length > 0 && SQL_START_KEYWORDS.some((keyword) => normalized.startsWith(keyword));
}

export function extractSqlFromResponse(aiResponse: string) {
  let sqlResult = aiResponse.trim();
  const codeBlock = aiResponse.match(/```sql?([\s\S]*?)```/i);
  if (codeBlock?.[1]) {
    sqlResult = codeBlock[1].trim();
  } else {
    if (hasSqlStartKeyword(sqlResult)) return sqlResult;

    const lines = aiResponse.split("\n").map((line) => line.trimEnd());
    const sqlStartIndex = lines.findIndex((line) => hasSqlStartKeyword(line));
    if (sqlStartIndex < 0) return "";

    let startIndex = sqlStartIndex;
    while (startIndex > 0) {
      const previousLine = lines[startIndex - 1]?.trim() || "";
      if (
        previousLine === "" ||
        previousLine.startsWith("--") ||
        previousLine.startsWith("#") ||
        previousLine.startsWith("/*") ||
        previousLine.startsWith("*") ||
        previousLine.startsWith("*/")
      ) {
        startIndex -= 1;
        continue;
      }
      break;
    }

    sqlResult = lines.slice(startIndex).join("\n").trim();
  }

  return sqlResult;
}

export function stripSqlCodeBlocksFromResponse(aiResponse: string) {
  return aiResponse.replace(/```sql[\s\S]*?```/gi, "").trim();
}

export function summarizeRunResult(result: QueryResult) {
  if (result.rows.length > 0) {
    return `Returned ${result.rows.length} row${result.rows.length === 1 ? "" : "s"} in ${result.execution_time_ms} ms${result.truncated ? " with a truncated preview." : "."}`;
  }
  if (result.affected_rows > 0) {
    return `Applied changes to ${result.affected_rows} row${result.affected_rows === 1 ? "" : "s"} in ${result.execution_time_ms} ms.`;
  }
  return `Execution completed in ${result.execution_time_ms} ms.`;
}
