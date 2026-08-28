use crate::utils::sql::{classify_sql, SqlStatementDecision, SqlStatementKind};

pub fn clamp_safe_mode_level(level: u8) -> u8 {
    level.min(5)
}

pub fn assert_sql_allowed_at_level(level: u8, sql: &str) -> Result<(), String> {
    let level = clamp_safe_mode_level(level);
    if level == 0 {
        return Ok(());
    }

    let decision = classify_sql(sql);
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

    let blocked = decision.statements.iter().find(|statement| {
        (statement.kind == SqlStatementKind::Unknown && level > 0)
            || is_blocked_at_level(level, statement)
    });
    if blocked.is_some() {
        return Err(format!(
            "[Safe Mode level {level}] This statement is blocked. Upgrade to a lower protection level or disable Safe Mode in settings to proceed."
        ));
    }
    Ok(())
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
                || (canonical.starts_with("ALTER ") && !is_rename_column(&canonical))
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

fn is_rename_column(canonical: &str) -> bool {
    canonical.starts_with("ALTER TABLE") && canonical.contains(" RENAME COLUMN ")
}

#[cfg(test)]
mod tests {
    use super::{assert_sql_allowed_at_level, is_blocked_at_level};
    use crate::utils::sql::classify_sql;

    fn first_statement(sql: &str) -> crate::utils::sql::SqlStatementDecision {
        classify_sql(sql).statements.into_iter().next().unwrap()
    }

    #[test]
    fn level_one_allows_select_and_blocks_writes() {
        assert!(assert_sql_allowed_at_level(1, "SELECT 1").is_ok());
        assert!(assert_sql_allowed_at_level(1, "DELETE FROM users").is_err());
        assert!(assert_sql_allowed_at_level(1, "INSERT INTO users(id) VALUES (1)").is_err());
    }

    #[test]
    fn level_one_blocks_mutating_ctes_the_frontend_regex_missed() {
        let sql = "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed";
        assert!(assert_sql_allowed_at_level(1, sql).is_err());
        assert!(is_blocked_at_level(1, &first_statement(sql)));
    }

    #[test]
    fn level_two_allows_insert_but_not_update() {
        assert!(assert_sql_allowed_at_level(2, "INSERT INTO users(id) VALUES (1)").is_ok());
        assert!(assert_sql_allowed_at_level(2, "UPDATE users SET id = 1").is_err());
        assert!(assert_sql_allowed_at_level(2, "SELECT 1").is_ok());
    }

    #[test]
    fn level_three_blocks_drop_and_non_rename_alter() {
        assert!(assert_sql_allowed_at_level(3, "DROP TABLE users").is_err());
        assert!(assert_sql_allowed_at_level(3, "ALTER TABLE users ADD COLUMN x int").is_err());
        assert!(assert_sql_allowed_at_level(3, "INSERT INTO users(id) VALUES (1)").is_ok());
    }

    #[test]
    fn disabled_safe_mode_allows_everything() {
        assert!(assert_sql_allowed_at_level(0, "DROP TABLE users").is_ok());
    }
}
