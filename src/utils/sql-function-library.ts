/**
 * SQL Function Library — database-specific SQL functions organized by category.
 * Used by Monaco autocomplete and syntax highlighting for schema-aware suggestions.
 */

import type { DatabaseType } from "../types/database";

export interface SqlFunctionDef {
  name: string;
  signature?: string; // e.g., "(text, text)" for snippet
  description: string;
  category: FunctionCategory;
  /** Whether this is an aggregate function */
  isAggregate?: boolean;
  /** Whether this is a window function */
  isWindow?: boolean;
  /** Whether this is a JSON function */
  isJson?: boolean;
}

export type FunctionCategory =
  | "string"
  | "numeric"
  | "datetime"
  | "aggregate"
  | "window"
  | "json"
  | "array"
  | "null_handling"
  | "type_conversion"
  | "comparison"
  | "bitwise"
  | "network"
  | "uuid"
  | "crypto"
  | "xml"
  | "other";

/** Build a function definition with standard description */
function fn(
  name: string,
  category: FunctionCategory,
  description: string,
  extra?: Partial<SqlFunctionDef>,
): SqlFunctionDef {
  return { name, category, description, ...extra };
}

// ── Common Functions (shared across all databases) ──────────────────────────

const COMMON_FUNCTIONS: SqlFunctionDef[] = [
  // Aggregate
  fn("COUNT", "aggregate", "Count of rows"),
  fn("SUM", "aggregate", "Sum of values"),
  fn("AVG", "aggregate", "Average of values"),
  fn("MIN", "aggregate", "Minimum value"),
  fn("MAX", "aggregate", "Maximum value"),
  fn("COUNT(*)", "aggregate", "Count all rows including nulls"),
  // String
  fn("CONCAT", "string", "Concatenate strings"),
  fn("CONCAT_WS", "string", "Concatenate with separator"),
  fn("SUBSTRING", "string", "Extract substring", { signature: "(str, start, len)" }),
  fn("SUBSTR", "string", "Extract substring (alias)"),
  fn("LENGTH", "string", "String length in characters"),
  fn("LEN", "string", "String length"),
  fn("CHAR_LENGTH", "string", "String length in characters"),
  fn("UPPER", "string", "Convert to uppercase"),
  fn("LOWER", "string", "Convert to lowercase"),
  fn("TRIM", "string", "Remove leading/trailing whitespace"),
  fn("LTRIM", "string", "Remove leading whitespace"),
  fn("RTRIM", "string", "Remove trailing whitespace"),
  fn("LPAD", "string", "Pad left", { signature: "(str, len, pad)" }),
  fn("RPAD", "string", "Pad right", { signature: "(str, len, pad)" }),
  fn("REPLACE", "string", "Replace substring", { signature: "(str, old, new)" }),
  fn("REVERSE", "string", "Reverse string"),
  fn("LEFT", "string", "Leftmost characters", { signature: "(str, len)" }),
  fn("RIGHT", "string", "Rightmost characters", { signature: "(str, len)" }),
  fn("INSTR", "string", "Position of substring"),
  fn("POSITION", "string", "Position of substring"),
  fn("INITCAP", "string", "Capitalize first letter of each word"),
  // Numeric
  fn("ABS", "numeric", "Absolute value"),
  fn("ROUND", "numeric", "Round to decimal places", { signature: "(value, decimals)" }),
  fn("FLOOR", "numeric", "Round down to integer"),
  fn("CEIL", "numeric", "Round up to integer"),
  fn("CEILING", "numeric", "Round up to integer"),
  fn("MOD", "numeric", "Modulo remainder", { signature: "(a, b)" }),
  fn("POWER", "numeric", "Exponentiation", { signature: "(base, exp)" }),
  fn("SQRT", "numeric", "Square root"),
  fn("LN", "numeric", "Natural logarithm"),
  fn("LOG", "numeric", "Logarithm base 10"),
  fn("LOG10", "numeric", "Logarithm base 10"),
  fn("EXP", "numeric", "Exponential (e^x)"),
  fn("SIGN", "numeric", "Sign of value (-1, 0, 1)"),
  fn("RAND", "numeric", "Random value 0-1"),
  fn("RANDOM", "numeric", "Random value 0-1"),
  // Date/Time
  fn("NOW", "datetime", "Current timestamp"),
  fn("CURRENT_DATE", "datetime", "Current date"),
  fn("CURRENT_TIME", "datetime", "Current time"),
  fn("CURRENT_TIMESTAMP", "datetime", "Current timestamp"),
  fn("DATE", "datetime", "Extract date from timestamp"),
  fn("DATE_ADD", "datetime", "Add interval to date", { signature: "(date, INTERVAL)" }),
  fn("DATE_SUB", "datetime", "Subtract interval from date"),
  fn("DATE_DIFF", "datetime", "Difference between dates"),
  fn("DATE_TRUNC", "datetime", "Truncate to unit", { signature: "('unit', date)" }),
  fn("TO_CHAR", "datetime", "Format timestamp as string", { signature: "(value, format)" }),
  fn("TO_DATE", "datetime", "Parse string to date", { signature: "(str, format)" }),
  fn("TO_TIMESTAMP", "datetime", "Parse to timestamp"),
  fn("EXTRACT", "datetime", "Extract date part", { signature: "(part FROM date)" }),
  fn("AGE", "datetime", "Subtract from current date"),
  // Null handling
  fn("COALESCE", "null_handling", "First non-null argument", { signature: "(arg1, arg2, ...)" }),
  fn("NULLIF", "null_handling", "NULL if equal", { signature: "(a, b)" }),
  fn("NVL", "null_handling", "If null, use alternate value"),
  fn("IFNULL", "null_handling", "If null, use alternate value"),
  fn("IF", "null_handling", "Conditional expression", { signature: "(cond, true_val, false_val)" }),
  // Type conversion
  fn("CAST", "type_conversion", "Explicit type conversion", { signature: "(value AS type)" }),
  fn("CONVERT", "type_conversion", "Convert between types"),
  // Comparison
  fn("CASE", "comparison", "Conditional expression"),
  fn("WHEN", "comparison", "Case condition"),
  fn("THEN", "comparison", "Case result"),
  fn("ELSE", "comparison", "Case else result"),
  fn("END", "comparison", "End case expression"),
  fn("IIF", "comparison", "Inline if"),
  // Window
  fn("ROW_NUMBER", "window", "Row number within partition", { isWindow: true }),
  fn("RANK", "window", "Rank with gaps", { isWindow: true }),
  fn("DENSE_RANK", "window", "Rank without gaps", { isWindow: true }),
  fn("PERCENT_RANK", "window", "Percent rank within partition", { isWindow: true }),
  fn("NTILE", "window", "Divide into buckets", { isWindow: true }),
  fn("LAG", "window", "Value from preceding row", { isWindow: true }),
  fn("LEAD", "window", "Value from following row", { isWindow: true }),
  fn("FIRST_VALUE", "window", "First value in window frame", { isWindow: true }),
  fn("LAST_VALUE", "window", "Last value in window frame", { isWindow: true }),
  fn("NTH_VALUE", "window", "Nth value in window frame", { isWindow: true }),
  fn("OVER", "window", "Window specification"),
  fn("PARTITION BY", "window", "Window partition clause"),
  // JSON
  fn("JSON_EXTRACT", "json", "Extract JSON value", { isJson: true }),
  fn("JSON_VALUE", "json", "Extract JSON as scalar", { isJson: true }),
  fn("JSON_OBJECT", "json", "Create JSON object", { isJson: true }),
  fn("JSON_ARRAY", "json", "Create JSON array", { isJson: true }),
  fn("JSON_LENGTH", "json", "Length of JSON array/object", { isJson: true }),
  fn("JSON_KEYS", "json", "Keys of JSON object", { isJson: true }),
  fn("JSON_VALID", "json", "Check if valid JSON", { isJson: true }),
  // Array
  fn("ARRAY", "array", "Create array literal"),
  fn("UNNEST", "array", "Expand array to rows"),
  fn("ARRAY_AGG", "array", "Aggregate into array", { isAggregate: true }),
  fn("ARRAY_LENGTH", "array", "Length of array"),
  fn("CARDINALITY", "array", "Length of array (Postgres)"),
  fn("GENERATE_SERIES", "array", "Generate series of values"),
  // Bitwise
  fn("BIT_AND", "bitwise", "Bitwise AND aggregate", { isAggregate: true }),
  fn("BIT_OR", "bitwise", "Bitwise OR aggregate", { isAggregate: true }),
  fn("BIT_XOR", "bitwise", "Bitwise XOR aggregate", { isAggregate: true }),
  // UUID
  fn("GEN_RANDOM_UUID", "uuid", "Generate random UUID (v4)"),
  fn("UUID_GENERATE_V4", "uuid", "Generate UUID v4 (Postgres)"),
  // Crypto
  fn("MD5", "crypto", "MD5 hash"),
  fn("SHA1", "crypto", "SHA-1 hash"),
  fn("SHA256", "crypto", "SHA-256 hash"),
  fn("SHA384", "crypto", "SHA-384 hash"),
  fn("SHA512", "crypto", "SHA-512 hash"),
  // XML
  fn("XMLAGG", "xml", "Aggregate XML values", { isAggregate: true }),
  fn("XPATH", "xml", "Query XML with XPath"),
];

// ── PostgreSQL-specific functions ───────────────────────────────────────────

const POSTGRESQL_FUNCTIONS: SqlFunctionDef[] = [
  fn("uuid_generate_v1", "uuid", "Generate UUID v1 (timestamp-based)"),
  fn("uuid_generate_v1mc", "uuid", "Generate UUID v1mc (mac-based)"),
  fn("now", "datetime", "Current timestamp"),
  fn("transaction_timestamp", "datetime", "Current transaction timestamp"),
  fn("statement_timestamp", "datetime", "Current statement timestamp"),
  fn("clock_timestamp", "datetime", "Current clock timestamp"),
  fn("to_timestamp", "datetime", "Convert to timestamp", { signature: "(double precision)" }),
  fn("make_timestamp", "datetime", "Create timestamp from parts", { signature: "(year, month, day, hour, min, sec)" }),
  fn("make_interval", "datetime", "Create interval from parts", { signature: "(years, months, weeks, days, hours, mins, secs)" }),
  fn("make_date", "datetime", "Create date from parts", { signature: "(year, month, day)" }),
  fn("to_char", "datetime", "Format timestamp to string", { signature: "(value, format)" }),
  fn("to_date", "datetime", "Parse string to date", { signature: "(str, format)" }),
  fn("to_number", "datetime", "Parse string to number", { signature: "(str, format)" }),
  fn("format", "string", "Format string (Postgres-style)", { signature: "(format, arg1, ...)" }),
  fn("jsonb_pretty", "json", "Pretty-print JSONB", { isJson: true }),
  fn("jsonb_set", "json", "Set JSONB value at path", { isJson: true }),
  fn("jsonb_insert", "json", "Insert JSONB value at path", { isJson: true }),
  fn("jsonb_path_exists", "json", "Check JSONB path exists", { isJson: true }),
  fn("jsonb_extract_path", "json", "Extract JSONB at path", { isJson: true }),
  fn("jsonb_object_agg", "json", "Aggregate into JSONB object", { isJson: true, isAggregate: true }),
  fn("jsonb_array_elements", "json", "Expand JSONB array to rows", { isJson: true }),
  fn("jsonb_each", "json", "Expand JSONB object to rows", { isJson: true }),
  fn("jsonb_each_text", "json", "Expand JSONB object to text rows", { isJson: true }),
  fn("jsonb_delete", "json", "Delete JSONB key", { isJson: true }),
  fn("jsonb_delete_path", "json", "Delete JSONB path", { isJson: true }),
  fn("jsonb_build_object", "json", "Build JSONB object", { isJson: true }),
  fn("jsonb_build_array", "json", "Build JSONB array", { isJson: true }),
  fn("json_object_agg", "json", "Aggregate into JSON object", { isJson: true, isAggregate: true }),
  fn("row_to_json", "json", "Convert row to JSON", { isJson: true }),
  fn("array_to_json", "json", "Convert array to JSON", { isJson: true }),
  fn("json_agg", "json", "Aggregate to JSON array", { isJson: true, isAggregate: true }),
  fn("jsonb_agg", "json", "Aggregate to JSONB array", { isJson: true, isAggregate: true }),
  fn("to_tsvector", "json", "Convert text to tsvector (full-text search)"),
  fn("to_tsquery", "json", "Convert text to tsquery"),
  fn("ts_rank", "json", "Rank by tsquery match"),
  fn("ts_rank_cd", "json", "Rank by tsquery match (cover density)"),
  fn("tsvector_update_trigger", "json", "Auto-update tsvector trigger"),
  fn("string_agg", "aggregate", "Aggregate strings with separator", { isAggregate: true }),
  fn("array_agg", "aggregate", "Aggregate values into array", { isAggregate: true }),
  fn("json_agg", "aggregate", "Aggregate to JSON array", { isAggregate: true }),
  fn("jsonb_agg", "aggregate", "Aggregate to JSONB array", { isAggregate: true }),
  fn("percentile_cont", "aggregate", "Continuous percentile", { isAggregate: true }),
  fn("percentile_disc", "aggregate", "Discrete percentile", { isAggregate: true }),
  fn("cume_dist", "window", "Cumulative distribution", { isWindow: true }),
  fn("pg_column_size", "other", "Size of a column value"),
  fn("pg_total_relation_size", "other", "Total size of a relation"),
  fn("pg_indexes_size", "other", "Size of indexes on a relation"),
  fn("pg_relation_size", "other", "Size of a relation"),
  fn("pg_size_pretty", "other", "Human-readable size"),
  fn("pg_database_size", "other", "Size of a database"),
  fn("pg_ls_dir", "other", "List directory contents"),
  fn("pg_read_file", "other", "Read file contents"),
  fn("pg_write_file", "other", "Write to file"),
  fn("version", "other", "PostgreSQL version string"),
  fn("current_schema", "other", "Current schema"),
  fn("current_schemas", "other", "All visible schemas"),
  fn("current_setting", "other", "Current setting value", { signature: "(name)" }),
  fn("set_config", "other", "Set and return setting", { signature: "(name, value, is_local)" }),
  fn("pg_typeof", "type_conversion", "Get the type of a value"),
  fn("format_type", "type_conversion", "Get SQL type name from oid"),
  fn("col_description", "other", "Column comment"),
  fn("obj_description", "other", "Object comment"),
  fn("inet_server_addr", "network", "Server IP address"),
  fn("inet_server_port", "network", "Server port"),
  fn("inet_client_addr", "network", "Client IP address"),
  fn("inet_client_port", "network", "Client port"),
  fn("inet_aton", "network", "IP to integer"),
  fn("inet_ntoa", "network", "Integer to IP"),
  fn("network", "network", "Network address"),
  fn("broadcast", "network", "Broadcast address"),
  fn("host", "network", "Host address as text"),
  fn("netmask", "network", "Netmask as address"),
  fn("network_size", "network", "Size of network"),
];

// ── MySQL-specific functions ───────────────────────────────────────────────────

const MYSQL_FUNCTIONS: SqlFunctionDef[] = [
  fn("IFNULL", "null_handling", "If null, return alternate value"),
  fn("NULLIF", "null_handling", "NULL if two values are equal"),
  fn("ISNULL", "null_handling", "Test if expression is null"),
  fn("COALESCE", "null_handling", "First non-null argument"),
  fn("IF", "null_handling", "Conditional expression", { signature: "(condition, true_val, false_val)" }),
  fn("IIF", "null_handling", "Inline if", { signature: "(condition, true_val, false_val)" }),
  fn("CAST", "type_conversion", "Cast to type", { signature: "(expr AS type)" }),
  fn("CONVERT", "type_conversion", "Convert to type", { signature: "(expr, type)" }),
  fn("BIN", "type_conversion", "Binary representation"),
  fn("HEX", "type_conversion", "Hexadecimal representation"),
  fn("UNHEX", "type_conversion", "Hex string to binary"),
  fn("CHARSET", "type_conversion", "Character set of string"),
  fn("COLLATION", "type_conversion", "Collation of string"),
  fn("NOW", "datetime", "Current timestamp"),
  fn("SYSDATE", "datetime", "Current timestamp (time of execution)"),
  fn("CURDATE", "datetime", "Current date"),
  fn("CURTIME", "datetime", "Current time"),
  fn("UTC_DATE", "datetime", "Current UTC date"),
  fn("UTC_TIME", "datetime", "Current UTC time"),
  fn("UTC_TIMESTAMP", "datetime", "Current UTC timestamp"),
  fn("DATE_ADD", "datetime", "Add date interval", { signature: "(date, INTERVAL value unit)" }),
  fn("DATE_SUB", "datetime", "Subtract date interval", { signature: "(date, INTERVAL value unit)" }),
  fn("DATE_FORMAT", "datetime", "Format date as string", { signature: "(date, format)" }),
  fn("ADDDATE", "datetime", "Add date interval"),
  fn("SUBDATE", "datetime", "Subtract date interval"),
  fn("ADDTIME", "datetime", "Add time"),
  fn("SUBTIME", "datetime", "Subtract time"),
  fn("DATEDIFF", "datetime", "Days between dates"),
  fn("TIMEDIFF", "datetime", "Time difference"),
  fn("TIMESTAMP", "datetime", "Create timestamp"),
  fn("TIMESTAMPADD", "datetime", "Add timestamp interval", { signature: "(unit, interval, timestamp)" }),
  fn("TIMESTAMPDIFF", "datetime", "Timestamp difference", { signature: "(unit, ts1, ts2)" }),
  fn("FROM_DAYS", "datetime", "Date from day number"),
  fn("TO_DAYS", "datetime", "Day number from date"),
  fn("FROM_UNIXTIME", "datetime", "Timestamp from Unix time"),
  fn("UNIX_TIMESTAMP", "datetime", "Unix timestamp"),
  fn("STR_TO_DATE", "datetime", "Parse string as date", { signature: "(str, format)" }),
  fn("MAKEDATE", "datetime", "Create date from year/day"),
  fn("MAKETIME", "datetime", "Create time from hour/min/sec"),
  fn("PERIOD_ADD", "datetime", "Add months to period"),
  fn("PERIOD_DIFF", "datetime", "Difference between periods"),
  fn("WEEKDAY", "datetime", "Day of week (0=Monday)"),
  fn("DAYOFMONTH", "datetime", "Day of month (1-31)"),
  fn("DAYOFWEEK", "datetime", "Day of week (1=Sunday)"),
  fn("DAYOFYEAR", "datetime", "Day of year (1-366)"),
  fn("MONTH", "datetime", "Month number (1-12)"),
  fn("QUARTER", "datetime", "Quarter (1-4)"),
  fn("YEAR", "datetime", "Year"),
  fn("MONTHNAME", "datetime", "Month name"),
  fn("DAYNAME", "datetime", "Day name"),
  fn("DAY", "datetime", "Day of month"),
  fn("HOUR", "datetime", "Hour (0-23)"),
  fn("MINUTE", "datetime", "Minute (0-59)"),
  fn("SECOND", "datetime", "Second (0-59)"),
  fn("LAST_DAY", "datetime", "Last day of month"),
  fn("SEC_TO_TIME", "datetime", "Seconds to time"),
  fn("TIME_TO_SEC", "datetime", "Time to seconds"),
  fn("GET_FORMAT", "datetime", "Get date format string"),
  fn("SUBSTRING_INDEX", "string", "Substring up to Nth delimiter"),
  fn("INSTR", "string", "Position of substring"),
  fn("LOCATE", "string", "Position of substring"),
  fn("FIND_IN_SET", "string", "Position in comma-separated list"),
  fn("FORMAT", "string", "Format number with commas"),
  fn("ELT", "string", "Return Nth element from list"),
  fn("EXPORT_SET", "string", "Return set as bit-flags string"),
  fn("STRCMP", "string", "Compare two strings"),
  fn("SPACE", "string", "String of spaces"),
  fn("REPEAT", "string", "Repeat string N times"),
  fn("ASCII", "string", "ASCII code of first character"),
  fn("CHAR", "string", "Character from ASCII code(s)"),
  fn("SOUNDEX", "string", "Soundex similarity"),
  fn("DIFFERENCE", "string", "Soundex difference (0-4)"),
  fn("WEIGHT_STRING", "string", "Weight string for comparison"),
  fn("MD5", "crypto", "MD5 hash (160-bit hex)"),
  fn("SHA1", "crypto", "SHA-1 hash (40-char hex)"),
  fn("SHA2", "crypto", "SHA-2 hash", { signature: "(str, hash_len)" }),
  fn("SHA", "crypto", "SHA-1 hash (alias)"),
  fn("PASSWORD", "crypto", "Password hash (deprecated)"),
  fn("ENCRYPT", "crypto", "Encrypt string (Unix crypt)"),
  fn("DECODE", "crypto", "Decode base64 string"),
  fn("COMPRESS", "crypto", "Compress string"),
  fn("UNCOMPRESS", "crypto", "Uncompress string"),
  fn("AES_ENCRYPT", "crypto", "AES encryption", { signature: "(str, key_str)" }),
  fn("AES_DECRYPT", "crypto", "AES decryption", { signature: "(str, key_str)" }),
  fn("GROUP_CONCAT", "aggregate", "Concatenate with group", { isAggregate: true, signature: "(expr SEPARATOR ',')" }),
  fn("JSON_ARRAY", "json", "Create JSON array", { isJson: true }),
  fn("JSON_OBJECT", "json", "Create JSON object", { isJson: true }),
  fn("JSON_QUERY", "json", "Extract JSON value", { isJson: true }),
  fn("JSON_VALUE", "json", "Extract JSON as scalar", { isJson: true }),
  fn("JSON_EXTRACT", "json", "Extract JSON value", { isJson: true }),
  fn("JSON_UNQUOTE", "json", "Extract and unquote JSON value", { isJson: true }),
  fn("JSON_SET", "json", "Insert/update JSON value", { isJson: true }),
  fn("JSON_INSERT", "json", "Insert JSON value (no overwrite)", { isJson: true }),
  fn("JSON_REPLACE", "json", "Replace existing JSON value", { isJson: true }),
  fn("JSON_REMOVE", "json", "Remove JSON value", { isJson: true }),
  fn("JSON_MERGE", "json", "Merge JSON arrays/objects", { isJson: true }),
  fn("JSON_MERGE_PATCH", "json", "Merge JSON (RFC 7396 patch)", { isJson: true }),
  fn("JSON_MERGE_PRESERVE", "json", "Merge JSON (preserve duplicates)", { isJson: true }),
  fn("JSON_KEYS", "json", "Keys of JSON object", { isJson: true }),
  fn("JSON_LENGTH", "json", "Length of JSON", { isJson: true }),
  fn("JSON_CONTAINS", "json", "Check if JSON contains value", { isJson: true }),
  fn("JSON_CONTAINS_PATH", "json", "Check if JSON contains path", { isJson: true }),
  fn("JSON_DEPTH", "json", "Depth of JSON tree", { isJson: true }),
  fn("JSON_TYPE", "json", "Type of JSON value", { isJson: true }),
  fn("JSON_VALID", "json", "Check if valid JSON", { isJson: true }),
  fn("JSON_ARRAY_APPEND", "json", "Append to JSON array", { isJson: true }),
  fn("JSON_ARRAY_INSERT", "json", "Insert into JSON array", { isJson: true }),
  fn("JSON_SEARCH", "json", "Search JSON for string", { isJson: true }),
  fn("JSON_OVERLAPS", "json", "JSON arrays overlap", { isJson: true }),
  fn("ROW_NUMBER", "window", "Row number", { isWindow: true }),
  fn("RANK", "window", "Rank with gaps", { isWindow: true }),
  fn("DENSE_RANK", "window", "Rank without gaps", { isWindow: true }),
  fn("PERCENT_RANK", "window", "Percent rank", { isWindow: true }),
  fn("CUME_DIST", "window", "Cumulative distribution", { isWindow: true }),
  fn("NTILE", "window", "Divide into N buckets", { isWindow: true }),
  fn("LAG", "window", "Value from preceding row", { isWindow: true }),
  fn("LEAD", "window", "Value from following row", { isWindow: true }),
  fn("FIRST_VALUE", "window", "First value in frame", { isWindow: true }),
  fn("LAST_VALUE", "window", "Last value in frame", { isWindow: true }),
  fn("NTH_VALUE", "window", "Nth value in frame", { isWindow: true }),
  fn("ROW_COUNT", "other", "Rows affected by previous statement"),
  fn("LAST_INSERT_ID", "other", "Auto-increment value from last insert"),
  fn("FOUND_ROWS", "other", "Row count from previous SELECT"),
  fn("INET_ATON", "network", "IP address to integer"),
  fn("INET_NTOA", "network", "Integer to IP address"),
  fn("INET6_ATON", "network", "IPv6 address to binary"),
  fn("INET6_NTOA", "network", "Binary to IPv6 address"),
  fn("IS_IPV4", "network", "Check if IPv4 address"),
  fn("IS_IPV6", "network", "Check if IPv6 address"),
  fn("UUID", "uuid", "Generate UUID"),
  fn("UUID_SHORT", "uuid", "Generate short integer UUID"),
  fn("GREATEST", "comparison", "Greatest of all arguments"),
  fn("LEAST", "comparison", "Least of all arguments"),
  fn("INTERVAL", "comparison", "Value index in ordered list"),
  fn("INET_SAME_FAMILY", "network", "Check if IPs in same family"),
];

// ── SQLite-specific functions ─────────────────────────────────────────────────

const SQLITE_FUNCTIONS: SqlFunctionDef[] = [
  fn("substr", "string", "Extract substring", { signature: "(str, start, len)" }),
  fn("instr", "string", "Position of substring"),
  fn("replace", "string", "Replace substring"),
  fn("printf", "string", "Format string (SQLite)"),
  fn("date", "datetime", "Current date or parse date"),
  fn("time", "datetime", "Current time or parse time"),
  fn("datetime", "datetime", "Current datetime or parse datetime"),
  fn("julianday", "datetime", "Julian day number"),
  fn("strftime", "datetime", "Format datetime", { signature: "(format, date)" }),
  fn("group_concat", "aggregate", "Concatenate with separator", { isAggregate: true }),
  fn("json_group_array", "json", "Aggregate to JSON array", { isJson: true, isAggregate: true }),
  fn("json_group_object", "json", "Aggregate to JSON object", { isJson: true, isAggregate: true }),
  fn("ifnull", "null_handling", "If null, return alternate value"),
  fn("nullif", "null_handling", "NULL if two values are equal"),
  fn("coalesce", "null_handling", "First non-null argument"),
  fn("typeof", "type_conversion", "SQL data type of value"),
  fn("cast", "type_conversion", "Cast to type", { signature: "(expr AS type)" }),
  fn("total", "aggregate", "Sum of values (never NULL)"),
  fn("abs", "numeric", "Absolute value"),
  fn("changes", "other", "Rows affected by last INSERT/UPDATE/DELETE"),
  fn("last_insert_rowid", "other", "Rowid of last insert"),
  fn("sqlite_compileoption_get", "other", "Get compile option"),
  fn("sqlite_compileoption_used", "other", "Check if compile option used"),
  fn("sqlite_offset", "other", "Offset of row in result set"),
  fn("quote", "string", "Quoted SQL literal"),
  fn("randomblob", "other", "Random binary blob"),
  fn("hex", "type_conversion", "Hex representation"),
  fn("unhex", "type_conversion", "Binary from hex string"),
  fn("zeroblob", "other", "Zero-filled blob of N bytes"),
  fn("likelihood", "other", "Likelihood of condition (for query planner)"),
  fn("likely", "other", "Condition is likely true"),
  fn("unlikely", "other", "Condition is unlikely true"),
];

// ── Build function catalog per database ──────────────────────────────────────

const DB_FUNCTIONS: Partial<Record<DatabaseType, SqlFunctionDef[]>> = {
  postgresql: [...COMMON_FUNCTIONS, ...POSTGRESQL_FUNCTIONS],
  mysql: [...COMMON_FUNCTIONS, ...MYSQL_FUNCTIONS],
  mariadb: [...COMMON_FUNCTIONS, ...MYSQL_FUNCTIONS],
  sqlite: [...COMMON_FUNCTIONS, ...SQLITE_FUNCTIONS],
  mssql: COMMON_FUNCTIONS,
  clickhouse: COMMON_FUNCTIONS,
  snowflake: COMMON_FUNCTIONS,
  bigquery: COMMON_FUNCTIONS,
  duckdb: COMMON_FUNCTIONS,
};

/**
 * Get all SQL function definitions for a database type.
 * Falls back to postgresql if the type is unknown.
 */
export function getSqlFunctionLibrary(dbType: DatabaseType | undefined): SqlFunctionDef[] {
  if (dbType && DB_FUNCTIONS[dbType]) {
    return DB_FUNCTIONS[dbType]!;
  }
  return DB_FUNCTIONS.postgresql ?? COMMON_FUNCTIONS;
}

/**
 * Get SQL function definitions filtered by category.
 */
export function getSqlFunctionsByCategory(
  dbType: DatabaseType | undefined,
  category: FunctionCategory,
): SqlFunctionDef[] {
  return getSqlFunctionLibrary(dbType).filter((f) => f.category === category);
}

/**
 * Get SQL function definitions filtered by name prefix (for autocomplete).
 */
export function getSqlFunctionsByPrefix(
  dbType: DatabaseType | undefined,
  prefix: string,
  limit = 50,
): SqlFunctionDef[] {
  const lower = prefix.toLowerCase();
  return getSqlFunctionLibrary(dbType)
    .filter((f) => f.name.toLowerCase().startsWith(lower))
    .slice(0, limit);
}

/**
 * Get aggregate functions for a database type.
 */
export function getAggregateFunctions(dbType: DatabaseType | undefined): SqlFunctionDef[] {
  return getSqlFunctionLibrary(dbType).filter((f) => f.isAggregate);
}

/**
 * Get window functions for a database type.
 */
export function getWindowFunctions(dbType: DatabaseType | undefined): SqlFunctionDef[] {
  return getSqlFunctionLibrary(dbType).filter((f) => f.isWindow);
}

/**
 * Get JSON functions for a database type.
 */
export function getJsonFunctions(dbType: DatabaseType | undefined): SqlFunctionDef[] {
  return getSqlFunctionLibrary(dbType).filter((f) => f.isJson);
}
