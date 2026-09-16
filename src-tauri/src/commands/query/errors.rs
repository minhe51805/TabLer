//! Human-readable query error formatting shared by the query commands.

pub(super) fn format_query_connection_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("connect first") {
        "The selected connection is not active. Please reconnect and try again.".to_string()
    } else {
        "The database connection is not available right now. Please reconnect and try again."
            .to_string()
    }
}

pub(super) fn format_query_runtime_error(error: impl std::fmt::Display) -> String {
    let raw_message = error.to_string();
    let compact_message = raw_message.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = compact_message.to_ascii_lowercase();

    if normalized.contains("permission") || normalized.contains("access denied") {
        return "The current connection does not have permission to run this statement."
            .to_string();
    }

    if normalized.contains("authentication")
        || normalized.contains("password")
        || normalized.contains("auth failed")
    {
        return "Database authentication failed. Please verify the connection settings."
            .to_string();
    }

    if normalized.contains("refused")
        || normalized.contains("broken pipe")
        || normalized.contains("connection reset")
        || normalized.contains("connection closed")
        || normalized.contains("not connected")
    {
        return "The database connection is no longer available. Please reconnect and try again."
            .to_string();
    }

    if normalized.contains("syntax")
        || normalized.contains("parse")
        || normalized.contains("parser")
        || normalized.contains("unexpected")
        || normalized.contains("unrecognized token")
        || normalized.contains("unterminated")
        || normalized.contains("near ")
    {
        return format!("SQL syntax error: {}", compact_message);
    }

    if normalized.contains("does not exist")
        || normalized.contains("unknown table")
        || normalized.contains("unknown column")
        || normalized.contains("no such table")
        || normalized.contains("no such column")
        || normalized.contains("invalid object name")
        || normalized.contains("invalid column")
        || normalized.contains("column not found")
        || normalized.contains("relation ")
    {
        return format!("Database object error: {}", compact_message);
    }

    if normalized.contains("ambiguous")
        || normalized.contains("duplicate column")
        || normalized.contains("duplicate alias")
        || normalized.contains("more than one row")
    {
        return format!("Query structure error: {}", compact_message);
    }

    if compact_message.is_empty() {
        "Query execution failed. Please review the SQL and connection state.".to_string()
    } else {
        format!("Query execution failed: {}", compact_message)
    }
}
