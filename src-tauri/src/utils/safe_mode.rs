use crate::database::models::DatabaseType;
use crate::utils::sql::{classify_sql_with_dialect, SqlStatementDecision, SqlStatementKind};

pub fn clamp_safe_mode_level(level: u8) -> u8 {
    level.min(5)
}

/// Same policy as a plain `assert_sql_allowed_at_level`, except a
/// `user_approved` run (the human saw this exact SQL and approved it — query
/// editor confirmation dialog, or the standing full-autonomy grant) may pass
/// the level 1-3 write/DDL block. Parse errors and the level 4-5
/// always-blocked family (DROP/TRUNCATE/CREATE TABLE) still fail for everyone.
///
/// `database_type` must be the connection's real engine: dialect-specific
/// statements (MySQL `SHOW`, `DESCRIBE`, …) only classify correctly when the
/// parser speaks the same dialect the server does.
pub fn assert_sql_allowed_at_level_with_approval(
    level: u8,
    sql: &str,
    database_type: Option<DatabaseType>,
    user_approved: bool,
) -> Result<(), String> {
    let level = clamp_safe_mode_level(level);
    if level == 0 {
        return Ok(());
    }

    let decision = classify_sql_with_dialect(sql, database_type);
    if decision.statements.is_empty() {
        return Err(decision
            .parse_error
            .unwrap_or_else(|| "SQL contains no executable statements.".to_string()));
    }
    if let Some(error) = decision.parse_error.as_ref() {
        return Err(format!(
            "Safe Mode could not classify this SQL reliably: {error}"
        ));
    }

    // Human approval only relaxes levels 1-3; strict/production tiers keep
    // their always-blocked family regardless of any approval flag.
    let human_approved_write = user_approved && level <= 3;
    let blocked = decision.statements.iter().find(|statement| {
        if human_approved_write {
            return false;
        }
        (statement.kind == SqlStatementKind::Unknown && level > 0)
            || is_blocked_at_level(level, statement)
    });
    if blocked.is_some() {
        return Err(format!(
            "[Safe Mode level {level} ({})] This statement is blocked. Upgrade to a lower protection level or disable Safe Mode in settings to proceed.",
            safe_mode_level_label(level)
        ));
    }
    Ok(())
}

/// Display label matching the frontend `SAFE_MODE_LABELS` table so a blocked
/// error names the tier the user actually picked ("level 1 (Read Only)").
fn safe_mode_level_label(level: u8) -> &'static str {
    match level {
        1 => "Read Only",
        2 => "Low Risk",
        3 => "Standard",
        4 => "Strict",
        5 => "Paranoid",
        _ => "Disabled",
    }
}

pub fn is_blocked_at_level(level: u8, statement: &SqlStatementDecision) -> bool {
    let canonical = statement.sql.trim().to_ascii_uppercase();
    match level {
        0 => false,
        1 => statement.kind != SqlStatementKind::Read,
        2 => match statement.kind {
            SqlStatementKind::Read => false,
            SqlStatementKind::Write => !canonical.starts_with("INSERT"),
            _ => true,
        },
        3 => {
            is_hard_blocked_schema(&canonical)
                || (canonical.starts_with("ALTER ") && !is_rename_column_only(&statement.sql))
        }
        4 | 5 => is_hard_blocked_schema(&canonical),
        _ => false,
    }
}

fn is_hard_blocked_schema(canonical: &str) -> bool {
    canonical.starts_with("DROP ")
        || canonical.starts_with("TRUNCATE ")
        || canonical.starts_with("CREATE TABLE")
}

/// Level-3 carve-out: `ALTER TABLE … RENAME COLUMN` is the one DDL a Standard
/// tier permits. The old substring check let `RENAME COLUMN a TO b, DROP
/// COLUMN c` slip through because it only looked for the phrase — this parses
/// the statement and requires EVERY operation to be a column rename, so a
/// rename smuggling a second action is blocked. Unparseable ALTERs fail
/// closed (blocked), matching the rest of the boundary.
fn is_rename_column_only(sql: &str) -> bool {
    use sqlparser::ast::{AlterTableOperation, Statement};
    use sqlparser::dialect::GenericDialect;
    use sqlparser::parser::Parser;

    let Ok(parsed) = Parser::parse_sql(&GenericDialect {}, sql) else {
        return false;
    };
    parsed.len() == 1
        && match &parsed[0] {
            Statement::AlterTable { operations, .. } => {
                !operations.is_empty()
                    && operations
                        .iter()
                        .all(|op| matches!(op, AlterTableOperation::RenameColumn { .. }))
            }
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::{assert_sql_allowed_at_level_with_approval, is_blocked_at_level};
    use crate::utils::sql::classify_sql;

    fn assert_allowed(level: u8, sql: &str, approved: bool) -> Result<(), String> {
        assert_sql_allowed_at_level_with_approval(level, sql, None, approved)
    }

    fn first_statement(sql: &str) -> crate::utils::sql::SqlStatementDecision {
        classify_sql(sql).statements.into_iter().next().unwrap()
    }

    #[test]
    fn level_one_allows_select_and_blocks_writes() {
        assert!(assert_allowed(1, "SELECT 1", false).is_ok());
        assert!(assert_allowed(1, "DELETE FROM users", false).is_err());
        assert!(assert_allowed(1, "INSERT INTO users(id) VALUES (1)", false).is_err());
    }

    #[test]
    fn level_one_error_names_the_read_only_tier() {
        let error = assert_allowed(1, "DELETE FROM users", false).unwrap_err();
        assert!(
            error.contains("level 1") && error.contains("Read Only"),
            "level-1 block should name the tier: {error}"
        );
    }

    #[test]
    fn level_one_blocks_mutating_ctes_the_frontend_regex_missed() {
        let sql = "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed";
        assert!(assert_allowed(1, sql, false).is_err());
        assert!(is_blocked_at_level(1, &first_statement(sql)));
    }

    #[test]
    fn level_two_allows_insert_but_not_update() {
        assert!(assert_allowed(2, "INSERT INTO users(id) VALUES (1)", false).is_ok());
        assert!(assert_allowed(2, "UPDATE users SET id = 1", false).is_err());
        assert!(assert_allowed(2, "SELECT 1", false).is_ok());
    }

    #[test]
    fn level_three_blocks_drop_and_non_rename_alter() {
        assert!(assert_allowed(3, "DROP TABLE users", false).is_err());
        assert!(assert_allowed(3, "ALTER TABLE users ADD COLUMN x int", false).is_err());
        assert!(assert_allowed(3, "INSERT INTO users(id) VALUES (1)", false).is_ok());
    }

    #[test]
    fn level_three_allows_pure_rename_column_only() {
        assert!(assert_allowed(3, "ALTER TABLE users RENAME COLUMN a TO b", false).is_ok());
        // A rename smuggling a second action must not ride the carve-out.
        assert!(assert_allowed(
            3,
            "ALTER TABLE users RENAME COLUMN a TO b, DROP COLUMN c",
            false
        )
        .is_err());
        assert!(assert_allowed(
            3,
            "ALTER TABLE users RENAME COLUMN a TO b, ADD COLUMN c int",
            false
        )
        .is_err());
        // RENAME TO (table rename) is not the column-rename carve-out.
        assert!(assert_allowed(3, "ALTER TABLE users RENAME TO people", false).is_err());
    }

    #[test]
    fn disabled_safe_mode_allows_everything() {
        assert!(assert_allowed(0, "DROP TABLE users", false).is_ok());
    }

    #[test]
    fn user_approval_lets_writes_pass_at_levels_one_to_three() {
        for level in 1..=3u8 {
            assert!(
                assert_allowed(level, "DELETE FROM users", true).is_ok(),
                "approved DELETE should pass at level {level}"
            );
        }
        // Without the flag the hard block stays.
        assert!(assert_allowed(1, "DELETE FROM users", false).is_err());
    }

    #[test]
    fn user_approval_still_passes_stricter_backend_classification_through() {
        // The frontend regex reads a mutating CTE as a read, so a confirmed
        // run carries the approval flag; the backend honors it at level <= 3.
        let sql = "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed";
        assert!(assert_allowed(1, sql, true).is_ok());
    }

    #[test]
    fn user_approval_never_relaxes_levels_four_and_five() {
        assert!(assert_allowed(5, "DROP TABLE users", true).is_err());
        assert!(assert_allowed(4, "TRUNCATE TABLE users", true).is_err());
        // Plain writes were already allowed at 4-5 (confirm tier is UI-side).
        assert!(assert_allowed(5, "UPDATE users SET id = 1", true).is_ok());
    }
}
