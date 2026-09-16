use super::PostgresDriver;
use crate::database::models::*;
use crate::database::query_common::statement_returns_rows;
use crate::utils::sql::split_sql_statements;
use anyhow::Result;
use sqlx::postgres::PgConnection;
use std::time::Instant;

impl PostgresDriver {
    pub(crate) fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("public".to_string(), table.to_string())
        }
    }

    pub(super) fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH"])
    }

    pub(super) async fn execute_query_on_conn(
        conn: &mut PgConnection,
        sql: &str,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let (rows, truncated) = Self::fetch_rows_limited(&mut *conn, sql).await?;
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            return Ok(result);
        }

        let mut total_affected: u64 = 0;
        let mut last_result: Option<QueryResult> = None;
        let iterable: Vec<&String> = if statements.len() > 1 {
            statements.iter().collect()
        } else {
            statements.first().into_iter().collect()
        };

        for statement in iterable {
            if Self::query_returns_rows(statement) {
                let (rows, truncated) = Self::fetch_rows_limited(&mut *conn, statement).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                    truncated,
                ));
            } else {
                let result = sqlx::query(statement).execute(&mut *conn).await?;
                total_affected += result.rows_affected();
            }
        }

        let elapsed = start.elapsed().as_millis();
        if let Some(mut result) = last_result {
            result.execution_time_ms = elapsed;
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: elapsed,
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }
}
