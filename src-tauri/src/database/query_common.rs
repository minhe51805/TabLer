pub const MAX_QUERY_RESULT_ROWS: usize = 500;

pub fn statement_returns_rows(sql: &str, prefixes: &[&str]) -> bool {
    let trimmed = sql.trim().to_uppercase();
    prefixes.iter().any(|prefix| trimmed.starts_with(prefix)) || trimmed.contains(" RETURNING ")
}
