pub const MAX_QUERY_RESULT_ROWS: usize = 500;
/// Row cap for metadata enumeration queries (e.g. schema object listing).
/// System databases like `master` contain thousands of system objects, far
/// above the interactive query cap, so metadata reads get their own limit.
pub const METADATA_QUERY_ROW_LIMIT: usize = 100_000;
pub const MAX_TABLE_PAGE_ROWS: u64 = 5_000;

fn strip_leading_sql_noise(sql: &str) -> &str {
    let mut remaining = sql;

    loop {
        remaining = remaining.trim_start();

        if let Some(after_line_comment) = remaining.strip_prefix("--") {
            if let Some((_, next_line)) = after_line_comment.split_once('\n') {
                remaining = next_line;
                continue;
            }
            return "";
        }

        if let Some(after_hash_comment) = remaining.strip_prefix('#') {
            if let Some((_, next_line)) = after_hash_comment.split_once('\n') {
                remaining = next_line;
                continue;
            }
            return "";
        }

        if let Some(after_block_comment) = remaining.strip_prefix("/*") {
            if let Some(block_end) = after_block_comment.find("*/") {
                remaining = &after_block_comment[block_end + 2..];
                continue;
            }
            return "";
        }

        return remaining;
    }
}

pub fn statement_returns_rows(sql: &str, prefixes: &[&str]) -> bool {
    let trimmed = strip_leading_sql_noise(sql).trim().to_uppercase();
    prefixes.iter().any(|prefix| trimmed.starts_with(prefix)) || trimmed.contains(" RETURNING ")
}

#[cfg(test)]
mod tests {
    use super::statement_returns_rows;

    const READ_PREFIXES: &[&str] = &[
        "SELECT", "WITH", "EXPLAIN", "SHOW", "PRAGMA", "DESCRIBE", "DESC", "TABLE", "VALUES",
    ];

    #[test]
    fn leading_comments_do_not_hide_the_real_verb() {
        for sql in [
            "-- note\nSELECT 1",
            "# mysql note\nSELECT 1",
            "/* block */ SELECT 1",
            "/* multi\nline */ WITH x AS (SELECT 1) SELECT * FROM x",
            "  \n\t-- a\n-- b\nSELECT 1",
        ] {
            assert!(statement_returns_rows(sql, &["SELECT", "WITH"]), "{sql:?}");
        }
        // A comment prefix cannot launder a write into a "read".
        for sql in [
            "-- innocent\nDROP TABLE t",
            "/* c */ DELETE FROM t",
            "# note\nUPDATE t SET x = 1",
        ] {
            assert!(!statement_returns_rows(sql, READ_PREFIXES), "{sql:?}");
        }
    }

    #[test]
    fn mutating_and_session_statements_report_no_rows() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET x = 1",
            "DELETE FROM t",
            "DROP TABLE t",
            "CREATE TABLE t (a int)",
            "ALTER TABLE t ADD COLUMN b int",
            "TRUNCATE t",
            "USE mydb",
            "SET foreign_key_checks = 0",
            "BEGIN",
        ] {
            assert!(!statement_returns_rows(sql, READ_PREFIXES), "{sql:?}");
        }
    }

    #[test]
    fn read_prefixes_classify_as_row_producing() {
        for sql in [
            "SELECT * FROM t",
            "  select 1",
            "WITH c AS (SELECT 1) SELECT * FROM c",
            "EXPLAIN SELECT * FROM t",
            "PRAGMA table_info(t)",
            "SHOW TABLES",
            "DESCRIBE users",
            "VALUES (1, 2)",
        ] {
            assert!(statement_returns_rows(sql, READ_PREFIXES), "{sql:?}");
        }
    }

    #[test]
    fn returning_clause_marks_writes_as_row_producing() {
        assert!(statement_returns_rows(
            "INSERT INTO t (a) VALUES (1) RETURNING id",
            &[]
        ));
        assert!(statement_returns_rows(
            "update t set x = 1 returning id",
            &[]
        ));
        assert!(statement_returns_rows(
            "DELETE FROM t WHERE id = 1 RETURNING *",
            &[]
        ));
    }

    #[test]
    fn empty_and_comment_only_inputs_report_no_rows() {
        for sql in [
            "",
            "   ",
            "-- nothing",
            "# nothing",
            "/* unterminated",
            "-- a\n-- b",
        ] {
            assert!(!statement_returns_rows(sql, READ_PREFIXES), "{sql:?}");
        }
    }
}
