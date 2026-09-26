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

#[cfg(test)]
mod tests {
    use super::{format_query_connection_error, format_query_runtime_error};

    #[test]
    fn connection_errors_distinguish_missing_from_unavailable() {
        assert_eq!(
            format_query_connection_error("connection not found"),
            "The selected connection is not active. Please reconnect and try again."
        );
        assert_eq!(
            format_query_connection_error("connect first"),
            "The selected connection is not active. Please reconnect and try again."
        );
        assert_eq!(
            format_query_connection_error("socket timed out"),
            "The database connection is not available right now. Please reconnect and try again."
        );
    }

    #[test]
    fn runtime_error_taxonomy_maps_keyword_classes() {
        // Permission beats everything — a 42501 must not collapse into syntax.
        assert_eq!(
            format_query_runtime_error("permission denied for relation users"),
            "The current connection does not have permission to run this statement."
        );
        assert_eq!(
            format_query_runtime_error("access denied for user 'app'"),
            "The current connection does not have permission to run this statement."
        );
        assert_eq!(
            format_query_runtime_error("password authentication failed"),
            "Database authentication failed. Please verify the connection settings."
        );
        assert_eq!(
            format_query_runtime_error("connection refused by remote host"),
            "The database connection is no longer available. Please reconnect and try again."
        );
        assert_eq!(
            format_query_runtime_error("connection reset by peer"),
            "The database connection is no longer available. Please reconnect and try again."
        );
        for raw in [
            "syntax error at or near \"selct\"",
            "unterminated quoted string",
            "unrecognized token: \"def\"",
            "parse error near line 3",
        ] {
            assert!(
                format_query_runtime_error(raw).starts_with("SQL syntax error:"),
                "{raw:?} must classify as syntax"
            );
        }
        for raw in [
            "relation \"users\" does not exist",
            "invalid object name 'orders'",
            "no such table: widgets",
            "column not found: c1",
        ] {
            assert!(
                format_query_runtime_error(raw).starts_with("Database object error:"),
                "{raw:?} must classify as object error"
            );
        }
        assert!(
            format_query_runtime_error("column reference \"id\" is ambiguous")
                .starts_with("Query structure error:")
        );
    }

    #[test]
    fn whitespace_is_compacted_and_unknown_errors_stay_generic() {
        let message = format_query_runtime_error("relation   \"t\"\ndoes not exist");
        assert_eq!(
            message,
            "Database object error: relation \"t\" does not exist"
        );
        assert_eq!(
            format_query_runtime_error("disk I/O error"),
            "Query execution failed: disk I/O error"
        );
        assert_eq!(
            format_query_runtime_error("   "),
            "Query execution failed. Please review the SQL and connection state."
        );
    }
}
