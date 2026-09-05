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
