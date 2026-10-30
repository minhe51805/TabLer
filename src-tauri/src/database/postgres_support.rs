use super::models::*;
use super::postgres::PostgresDriver;
use super::query_common::{statement_has_affected_row_count, MAX_QUERY_RESULT_ROWS};
use super::safety::{qualify_postgres_table_name, quote_postgres_identifier};
use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use log::warn;
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgArguments, PgConnection, PgPool, PgQueryResult, PgRow, PgStatement};
use sqlx::query::Query;
use sqlx::types::Json;
use sqlx::{
    Column, Execute, Executor, Postgres, QueryBuilder, Row, Transaction, TypeInfo, ValueRef,
};
use tokio::time::{timeout, Duration};

pub(super) enum CompatQuery<'q> {
    Prepared(Query<'q, Postgres, PgArguments>),
    Simple(&'q str),
}

impl<'q> CompatQuery<'q> {
    pub(super) fn new(database_type: DatabaseType, sql: &'q str) -> Self {
        if database_type == DatabaseType::Vertica {
            Self::Simple(sql)
        } else {
            Self::Prepared(sqlx::query(sql))
        }
    }
}

impl<'q> Execute<'q, Postgres> for CompatQuery<'q> {
    fn sql(&self) -> &'q str {
        match self {
            Self::Prepared(query) => query.sql(),
            Self::Simple(sql) => sql,
        }
    }

    fn statement(&self) -> Option<&PgStatement<'q>> {
        match self {
            Self::Prepared(query) => query.statement(),
            Self::Simple(_) => None,
        }
    }

    fn take_arguments(
        &mut self,
    ) -> Result<Option<PgArguments>, Box<dyn std::error::Error + Send + Sync>> {
        match self {
            Self::Prepared(query) => query.take_arguments(),
            Self::Simple(_) => Ok(None),
        }
    }

    fn persistent(&self) -> bool {
        match self {
            Self::Prepared(query) => query.persistent(),
            Self::Simple(_) => false,
        }
    }
}

pub(super) enum CompatTransaction {
    Postgres(Option<Transaction<'static, Postgres>>),
    Vertica(Option<PoolConnection<Postgres>>),
}

impl CompatTransaction {
    pub(super) async fn begin(pool: &PgPool, database_type: DatabaseType) -> Result<Self> {
        if database_type != DatabaseType::Vertica {
            return Ok(Self::Postgres(Some(pool.begin().await?)));
        }
        let mut conn = pool.acquire().await?;
        let initialized = async {
            conn.execute(CompatQuery::new(database_type, "SET AUTOCOMMIT = OFF"))
                .await?;
            conn.execute(CompatQuery::new(database_type, "BEGIN"))
                .await?;
            Ok::<(), sqlx::Error>(())
        }
        .await;
        if let Err(error) = initialized {
            conn.close_on_drop();
            return Err(error.into());
        }
        Ok(Self::Vertica(Some(conn)))
    }

    pub(super) fn conn(&mut self) -> &mut PgConnection {
        match self {
            Self::Postgres(transaction) => transaction
                .as_mut()
                .expect("PostgreSQL transaction connection is present")
                .as_mut(),
            Self::Vertica(conn) => conn
                .as_mut()
                .expect("Vertica transaction connection is present")
                .as_mut(),
        }
    }

    pub(super) async fn commit(mut self) -> Result<()> {
        match &mut self {
            Self::Postgres(transaction) => {
                if let Some(transaction) = transaction.take() {
                    transaction.commit().await?;
                }
            }
            Self::Vertica(conn) => {
                if let Some(conn) = conn.as_mut() {
                    conn.execute(CompatQuery::new(DatabaseType::Vertica, "COMMIT"))
                        .await?;
                    conn.execute(CompatQuery::new(
                        DatabaseType::Vertica,
                        "SET AUTOCOMMIT = ON",
                    ))
                    .await?;
                }
                conn.take();
            }
        }
        Ok(())
    }

    pub(super) async fn rollback(mut self) -> Result<()> {
        match &mut self {
            Self::Postgres(transaction) => {
                if let Some(transaction) = transaction.take() {
                    transaction.rollback().await?;
                }
            }
            Self::Vertica(conn) => {
                if let Some(conn) = conn.as_mut() {
                    conn.execute(CompatQuery::new(DatabaseType::Vertica, "ROLLBACK"))
                        .await?;
                    conn.execute(CompatQuery::new(
                        DatabaseType::Vertica,
                        "SET AUTOCOMMIT = ON",
                    ))
                    .await?;
                }
                conn.take();
            }
        }
        Ok(())
    }
}

impl Drop for CompatTransaction {
    fn drop(&mut self) {
        let Self::Vertica(conn) = self else {
            return;
        };
        if let Some(mut conn) = conn.take() {
            // A cancelled transaction must never return an open transaction to
            // the pool. Close this connection after the best-effort rollback.
            conn.close_on_drop();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    if let Err(error) = conn
                        .execute(CompatQuery::new(DatabaseType::Vertica, "ROLLBACK"))
                        .await
                    {
                        warn!("Vertica transaction rollback on drop failed: {error}");
                    }
                });
            }
        }
    }
}

pub(super) fn compat_text_parameter(value: &str) -> QueryParameter {
    QueryParameter {
        name: "text".to_string(),
        value: serde_json::Value::String(value.to_string()),
        data_type: QueryParameterType::Text,
    }
}

pub(super) fn compat_integer_parameter(value: i64) -> QueryParameter {
    QueryParameter {
        name: "integer".to_string(),
        value: serde_json::Value::from(value),
        data_type: QueryParameterType::Integer,
    }
}

pub(super) fn inline_vertica_parameterized_query(
    sql: &str,
    parameters: &[QueryParameter],
) -> Result<String> {
    let compiled = super::parameterized_query::compile_parameterized_query(
        sql,
        parameters,
        super::parameterized_query::PlaceholderStyle::DollarNumber,
    )?;
    inline_vertica_parameters(&compiled.sql, &compiled.parameters)
}

pub(super) async fn fetch_compat_positional_parameters(
    pool: &PgPool,
    database_type: DatabaseType,
    sql: &str,
    parameters: &[QueryParameter],
) -> Result<Vec<PgRow>> {
    if database_type == DatabaseType::Vertica {
        let inline_sql = inline_vertica_parameters(sql, parameters)?;
        return pool
            .fetch_all(inline_sql.as_str())
            .await
            .map_err(Into::into);
    }
    PostgresDriver::bind_parameterized_query(sqlx::query(sql), parameters)?
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub(super) async fn execute_compat_positional_parameters(
    pool: &PgPool,
    database_type: DatabaseType,
    sql: &str,
    parameters: &[QueryParameter],
) -> Result<PgQueryResult> {
    if database_type == DatabaseType::Vertica {
        let inline_sql = inline_vertica_parameters(sql, parameters)?;
        return pool.execute(inline_sql.as_str()).await.map_err(Into::into);
    }
    PostgresDriver::bind_parameterized_query(sqlx::query(sql), parameters)?
        .execute(pool)
        .await
        .map_err(Into::into)
}

pub(super) async fn execute_compat_statement(
    database_type: DatabaseType,
    conn: &mut PgConnection,
    sql: &str,
) -> Result<u64> {
    let outcome = conn.execute(CompatQuery::new(database_type, sql)).await?;
    if database_type == DatabaseType::Vertica && statement_has_affected_row_count(sql) {
        return vertica_affected_rows(conn).await;
    }
    Ok(outcome.rows_affected())
}

async fn vertica_affected_rows(conn: &mut PgConnection) -> Result<u64> {
    let row = conn
        .fetch_one(CompatQuery::new(
            DatabaseType::Vertica,
            "SELECT processed_row_count FROM v_monitor.query_profiles \
             WHERE session_id = current_session() AND NOT is_executing \
             ORDER BY query_start DESC, statement_id DESC LIMIT 1",
        ))
        .await
        .context("Vertica affected-row read-back failed")?;
    vertica_text(&row, 0)?
        .parse::<u64>()
        .context("Vertica returned an invalid affected-row count")
}

pub(super) async fn execute_compat_builder(
    database_type: DatabaseType,
    conn: &mut PgConnection,
    mut builder: QueryBuilder<'_, Postgres>,
) -> Result<u64> {
    if database_type == DatabaseType::Vertica {
        let sql = builder.into_sql();
        return execute_compat_statement(database_type, conn, &sql).await;
    }
    builder
        .build()
        .execute(conn)
        .await
        .map(|result| result.rows_affected())
        .map_err(Into::into)
}

pub(super) async fn fetch_compat_builder(
    database_type: DatabaseType,
    conn: &mut PgConnection,
    mut builder: QueryBuilder<'_, Postgres>,
) -> Result<Vec<PgRow>> {
    if database_type == DatabaseType::Vertica {
        let sql = builder.into_sql();
        return conn.fetch_all(sql.as_str()).await.map_err(Into::into);
    }
    builder.build().fetch_all(conn).await.map_err(Into::into)
}

fn inline_vertica_parameters(sql: &str, parameters: &[QueryParameter]) -> Result<String> {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(sql.len());
    let mut index = 0usize;
    let mut state = InlineState::Normal;
    let mut dollar_quote = None::<String>;
    let mut used = vec![false; parameters.len()];

    while index < chars.len() {
        if let Some(delimiter) = dollar_quote.as_deref() {
            let delimiter_chars = delimiter.chars().collect::<Vec<_>>();
            if chars[index..].starts_with(&delimiter_chars) {
                output.push_str(delimiter);
                index += delimiter_chars.len();
                dollar_quote = None;
            } else {
                output.push(chars[index]);
                index += 1;
            }
            continue;
        }

        let current = chars[index];
        match state {
            InlineState::Normal => {
                if current == '-' && chars.get(index + 1) == Some(&'-') {
                    output.push_str("--");
                    index += 2;
                    state = InlineState::LineComment;
                    continue;
                }
                if current == '/' && chars.get(index + 1) == Some(&'*') {
                    output.push_str("/*");
                    index += 2;
                    state = InlineState::BlockComment;
                    continue;
                }
                if current == '\'' {
                    output.push(current);
                    index += 1;
                    state = InlineState::SingleQuote;
                    continue;
                }
                if current == '"' {
                    output.push(current);
                    index += 1;
                    state = InlineState::DoubleQuote;
                    continue;
                }
                if current == '`' {
                    output.push(current);
                    index += 1;
                    state = InlineState::BacktickQuote;
                    continue;
                }
                if current == '$' {
                    if let Some((delimiter, next_index)) = dollar_quote_delimiter(&chars, index) {
                        output.push_str(&delimiter);
                        dollar_quote = Some(delimiter);
                        index = next_index;
                        continue;
                    }
                    if chars.get(index + 1).is_some_and(char::is_ascii_digit) {
                        let mut end = index + 1;
                        while chars.get(end).is_some_and(char::is_ascii_digit) {
                            end += 1;
                        }
                        let position = chars[index + 1..end]
                            .iter()
                            .collect::<String>()
                            .parse::<usize>()?;
                        if position == 0 {
                            return Err(anyhow::anyhow!("SQL parameter positions start at $1"));
                        }
                        let parameter = parameters.get(position - 1).ok_or_else(|| {
                            anyhow::anyhow!("No value was supplied for SQL parameter ${position}")
                        })?;
                        output.push_str(&vertica_literal(parameter)?);
                        used[position - 1] = true;
                        index = end;
                        continue;
                    }
                }
                output.push(current);
                index += 1;
            }
            InlineState::LineComment => {
                output.push(current);
                index += 1;
                if current == '\n' {
                    state = InlineState::Normal;
                }
            }
            InlineState::BlockComment => {
                output.push(current);
                if current == '*' && chars.get(index + 1) == Some(&'/') {
                    output.push('/');
                    index += 2;
                    state = InlineState::Normal;
                } else {
                    index += 1;
                }
            }
            InlineState::SingleQuote => {
                output.push(current);
                if current == '\'' && chars.get(index + 1) == Some(&'\'') {
                    output.push('\'');
                    index += 2;
                } else {
                    index += 1;
                    if current == '\'' {
                        state = InlineState::Normal;
                    }
                }
            }
            InlineState::DoubleQuote => {
                output.push(current);
                if current == '"' && chars.get(index + 1) == Some(&'"') {
                    output.push('"');
                    index += 2;
                } else {
                    index += 1;
                    if current == '"' {
                        state = InlineState::Normal;
                    }
                }
            }
            InlineState::BacktickQuote => {
                output.push(current);
                index += 1;
                if current == '`' {
                    state = InlineState::Normal;
                }
            }
        }
    }

    if let Some(unused) = used.iter().position(|used| !used) {
        return Err(anyhow::anyhow!(
            "SQL parameter ${} has a value but no placeholder",
            unused + 1
        ));
    }
    Ok(output)
}

fn dollar_quote_delimiter(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut end = start + 1;
    if chars.get(end) == Some(&'$') {
        return Some(("$$".to_string(), end + 1));
    }
    if !chars
        .get(end)
        .is_some_and(|value| *value == '_' || value.is_ascii_alphabetic())
    {
        return None;
    }
    end += 1;
    while chars
        .get(end)
        .is_some_and(|value| *value == '_' || value.is_ascii_alphanumeric())
    {
        end += 1;
    }
    if chars.get(end) == Some(&'$') {
        Some((chars[start..=end].iter().collect(), end + 1))
    } else {
        None
    }
}

#[derive(Clone, Copy)]
enum InlineState {
    Normal,
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    BacktickQuote,
}

fn vertica_literal(parameter: &QueryParameter) -> Result<String> {
    match parameter.data_type {
        QueryParameterType::Text => quote_vertica_string(
            parameter
                .value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Parameter '{}' must be text", parameter.name))?,
        ),
        QueryParameterType::Integer => Ok(parameter
            .value
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("Parameter '{}' must be an integer", parameter.name))?
            .to_string()),
        QueryParameterType::Decimal => {
            let value = parameter
                .value
                .as_f64()
                .ok_or_else(|| anyhow::anyhow!("Parameter '{}' must be numeric", parameter.name))?;
            if !value.is_finite() {
                return Err(anyhow::anyhow!(
                    "Parameter '{}' must be finite",
                    parameter.name
                ));
            }
            Ok(value.to_string())
        }
        QueryParameterType::Boolean => {
            Ok(
                if parameter.value.as_bool().ok_or_else(|| {
                    anyhow::anyhow!("Parameter '{}' must be boolean", parameter.name)
                })? {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                },
            )
        }
        QueryParameterType::Json => quote_vertica_string(&serde_json::to_string(&parameter.value)?),
        QueryParameterType::Null => Ok("NULL".to_string()),
    }
}

fn vertica_json_literal(value: &serde_json::Value) -> Result<String> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_string()),
        serde_json::Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => quote_vertica_string(value),
        _ => Err(anyhow::anyhow!(
            "Only string, number, boolean, and null values are supported"
        )),
    }
}

fn quote_vertica_string(value: &str) -> Result<String> {
    if value.contains('\0') {
        return Err(anyhow::anyhow!(
            "Vertica text parameters cannot contain a NUL character"
        ));
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

fn vertica_text(row: &PgRow, index: usize) -> Result<&str> {
    let value = row.try_get_raw(index)?;
    if value.is_null() {
        return Err(anyhow::anyhow!(
            "Vertica returned NULL for a required value"
        ));
    }
    value
        .as_str()
        .map_err(|error| anyhow::Error::msg(error.to_string()))
}

fn vertica_type_name(oid: u32) -> Option<&'static str> {
    Some(match oid {
        5 => "BOOLEAN",
        6 => "INTEGER",
        7 => "FLOAT",
        8 => "CHAR",
        9 => "VARCHAR",
        10 => "DATE",
        11 => "TIME",
        12 => "TIMESTAMP",
        13 => "TIMESTAMPTZ",
        14 | 114 => "INTERVAL",
        15 => "TIMETZ",
        16 => "NUMERIC",
        17 => "VARBINARY",
        20 => "UUID",
        115 => "LONG VARCHAR",
        116 => "LONG VARBINARY",
        117 => "BINARY",
        _ => return None,
    })
}

/// Query execution helpers, information_schema metadata reads, and FK lookup
/// for the PostgreSQL driver, split into a second inherent impl block.
impl PostgresDriver {
    pub(super) fn build_result_from_rows(
        database_type: DatabaseType,
        rows: &[PgRow],
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        truncated: bool,
    ) -> Result<QueryResult> {
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| {
                    let postgres_name = c.type_info().name();
                    let data_type = if database_type == DatabaseType::Vertica {
                        c.type_info()
                            .oid()
                            .and_then(|oid| vertica_type_name(oid.0))
                            .unwrap_or(postgres_name)
                    } else {
                        postgres_name
                    };
                    ColumnInfo {
                        name: c.name().to_string(),
                        data_type: data_type.to_string(),
                        is_nullable: true,
                        is_primary_key: false,
                        max_length: None,
                        default_value: None,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };

        let column_types = rows
            .first()
            .map(|first| {
                first
                    .columns()
                    .iter()
                    .map(|column| column.type_info().name().to_ascii_uppercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let result_rows = rows
            .iter()
            .map(|row| {
                row.columns()
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        Self::pg_cell_to_json(
                            database_type,
                            row,
                            i,
                            column_types.get(i).map(String::as_str),
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<Vec<_>>>()?;

        Ok(QueryResult {
            columns,
            rows: result_rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
            truncated,
        })
    }

    pub(super) async fn fetch_rows_limited<'a, E>(
        database_type: DatabaseType,
        executor: E,
        sql: &'a str,
    ) -> Result<(Vec<PgRow>, bool)>
    where
        E: Executor<'a, Database = Postgres>,
    {
        Self::fetch_rows_capped(database_type, executor, sql, MAX_QUERY_RESULT_ROWS).await
    }

    pub(super) async fn fetch_rows_capped<'a, E>(
        database_type: DatabaseType,
        executor: E,
        sql: &'a str,
        max_rows: usize,
    ) -> Result<(Vec<PgRow>, bool)>
    where
        E: Executor<'a, Database = Postgres>,
    {
        let max_rows = max_rows.max(1);
        let mut stream = executor.fetch(CompatQuery::new(database_type, sql));
        let mut rows = Vec::new();

        while let Some(row) = stream.try_next().await? {
            if rows.len() == max_rows {
                return Ok((rows, true));
            }
            rows.push(row);
        }

        Ok((rows, false))
    }

    pub(super) fn bind_parameterized_query<'q>(
        mut query: Query<'q, Postgres, PgArguments>,
        parameters: &[QueryParameter],
    ) -> Result<Query<'q, Postgres, PgArguments>> {
        for parameter in parameters {
            query = match parameter.data_type {
                QueryParameterType::Text => query.bind(
                    parameter
                        .value
                        .as_str()
                        .ok_or_else(|| {
                            anyhow::anyhow!("Parameter '{}' must be text.", parameter.name)
                        })?
                        .to_string(),
                ),
                QueryParameterType::Integer => {
                    query.bind(parameter.value.as_i64().ok_or_else(|| {
                        anyhow::anyhow!("Parameter '{}' must be an integer.", parameter.name)
                    })?)
                }
                QueryParameterType::Decimal => {
                    query.bind(parameter.value.as_f64().ok_or_else(|| {
                        anyhow::anyhow!("Parameter '{}' must be a number.", parameter.name)
                    })?)
                }
                QueryParameterType::Boolean => {
                    query.bind(parameter.value.as_bool().ok_or_else(|| {
                        anyhow::anyhow!("Parameter '{}' must be boolean.", parameter.name)
                    })?)
                }
                QueryParameterType::Json => query.bind(Json(parameter.value.clone())),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            };
        }
        Ok(query)
    }

    pub(super) fn decode_compat_i64(
        database_type: DatabaseType,
        row: &PgRow,
        index: usize,
    ) -> Result<i64> {
        if database_type == DatabaseType::Vertica {
            return vertica_text(row, index)?
                .parse::<i64>()
                .context("Vertica returned an invalid integer");
        }
        row.try_get::<i64, _>(index).map_err(Into::into)
    }

    fn metadata_boolean(row: &PgRow, index: usize, database_type: DatabaseType) -> Result<bool> {
        if database_type != DatabaseType::Vertica {
            return row.try_get::<bool, _>(index).map_err(Into::into);
        }
        let value = vertica_text(row, index)?;
        match value.trim().to_ascii_lowercase().as_str() {
            "t" | "true" | "1" => Ok(true),
            "f" | "false" | "0" => Ok(false),
            _ => Err(anyhow::anyhow!(
                "Vertica returned an invalid metadata boolean"
            )),
        }
    }

    pub(super) fn pg_cell_to_json(
        database_type: DatabaseType,
        row: &PgRow,
        index: usize,
        type_name: Option<&str>,
    ) -> Result<serde_json::Value> {
        if row
            .try_get_raw(index)
            .map(|value| value.is_null())
            .unwrap_or(false)
        {
            return Ok(serde_json::Value::Null);
        }

        if database_type == DatabaseType::Vertica {
            if let Some(oid) = row.column(index).type_info().oid().map(|oid| oid.0) {
                match oid {
                    5 => {
                        let value = vertica_text(row, index)?;
                        return match value.trim().to_ascii_lowercase().as_str() {
                            "t" | "true" | "1" => Ok(serde_json::Value::Bool(true)),
                            "f" | "false" | "0" => Ok(serde_json::Value::Bool(false)),
                            _ => Err(anyhow::anyhow!("Vertica returned an invalid boolean")),
                        };
                    }
                    6 => {
                        let value = vertica_text(row, index)?.parse::<i64>()?;
                        return Ok(serde_json::Value::from(value));
                    }
                    7 | 16 => {
                        let value = vertica_text(row, index)?.parse::<f64>()?;
                        let value = serde_json::Number::from_f64(value)
                            .ok_or_else(|| anyhow::anyhow!("Vertica number is not finite"))?;
                        return Ok(serde_json::Value::Number(value));
                    }
                    8..=15 | 17 | 20 | 114..=117 => {
                        return Ok(serde_json::Value::String(
                            vertica_text(row, index)?.to_string(),
                        ));
                    }
                    _ => {}
                }
            }
        }

        Ok(match type_name.unwrap_or_default() {
            "BOOL" => row
                .try_get::<bool, _>(index)
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null),
            "INT2" | "INT4" | "INT8" | "OID" => row
                .try_get::<i64, _>(index)
                .map(serde_json::Value::from)
                .or_else(|_| row.try_get::<i32, _>(index).map(serde_json::Value::from))
                .unwrap_or(serde_json::Value::Null),
            "FLOAT4" | "FLOAT8" | "NUMERIC" | "MONEY" => row
                .try_get::<f64, _>(index)
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null),
            "JSON" | "JSONB" => row
                .try_get::<Json<serde_json::Value>, _>(index)
                .map(|value| value.0)
                .unwrap_or(serde_json::Value::Null),
            "DATE" => row
                .try_get::<chrono::NaiveDate, _>(index)
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
            "TIME" => row
                .try_get::<chrono::NaiveTime, _>(index)
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
            "TIMESTAMP" => row
                .try_get::<chrono::NaiveDateTime, _>(index)
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
            "TIMESTAMPTZ" => row
                .try_get::<chrono::DateTime<chrono::Utc>, _>(index)
                .map(|value| serde_json::Value::String(value.to_rfc3339()))
                .unwrap_or(serde_json::Value::Null),
            _ => row
                .try_get::<String, _>(index)
                .map(serde_json::Value::String)
                .or_else(|_| row.try_get::<i64, _>(index).map(serde_json::Value::from))
                .or_else(|_| row.try_get::<f64, _>(index).map(serde_json::Value::from))
                .or_else(|_| row.try_get::<bool, _>(index).map(serde_json::Value::from))
                .unwrap_or(serde_json::Value::Null),
        })
    }

    pub(super) fn push_bound_value(
        database_type: DatabaseType,
        builder: &mut QueryBuilder<'_, Postgres>,
        value: &serde_json::Value,
    ) -> Result<()> {
        if database_type == DatabaseType::Vertica {
            builder.push(vertica_json_literal(value)?);
            return Ok(());
        }
        match value {
            serde_json::Value::Null => {
                builder.push("NULL");
            }
            serde_json::Value::Bool(value) => {
                builder.push_bind(*value);
            }
            serde_json::Value::Number(value) => {
                if let Some(int_value) = value.as_i64() {
                    builder.push_bind(int_value);
                } else if let Some(uint_value) = value.as_u64() {
                    if let Ok(signed_value) = i64::try_from(uint_value) {
                        builder.push_bind(signed_value);
                    } else if let Some(float_value) = value.as_f64() {
                        builder.push_bind(float_value);
                    } else {
                        return Err(anyhow::anyhow!("Unsupported numeric value"));
                    }
                } else if let Some(float_value) = value.as_f64() {
                    builder.push_bind(float_value);
                } else {
                    return Err(anyhow::anyhow!("Unsupported numeric value"));
                }
            }
            serde_json::Value::String(value) => {
                builder.push_bind(value.clone());
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "Only string, number, boolean, and null values are supported"
                ));
            }
        }

        Ok(())
    }

    pub(super) async fn list_schema_objects(
        &self,
        _database: Option<&str>,
    ) -> Result<Vec<SchemaObjectInfo>> {
        let mut objects = Vec::new();
        let pool = self.pool();
        let view_sql = if self.db_type == DatabaseType::Vertica {
            "SELECT table_schema, table_name, view_definition \
             FROM v_catalog.views WHERE NOT is_system_view \
             ORDER BY table_schema, table_name"
        } else {
            "SELECT table_schema, table_name, view_definition \
             FROM information_schema.views \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name"
        };
        let view_rows: Vec<PgRow> = pool
            .fetch_all(CompatQuery::new(self.db_type, view_sql))
            .await?;

        objects.extend(view_rows.iter().map(|row| SchemaObjectInfo {
            create_date: None,
            name: row.get(1),
            schema: row.try_get::<String, _>(0).ok(),
            object_type: "VIEW".to_string(),
            related_table: None,
            definition: row.try_get(2).ok(),
        }));

        // Vertica has no trigger catalog, and 9.2 has no procedures catalog.
        // Returning the supported views is preferable to failing the whole
        // schema tree on PostgreSQL-only relations.
        if self.db_type == DatabaseType::Vertica {
            return Ok(objects);
        }

        let trigger_rows: Vec<PgRow> = sqlx::query(
            "SELECT trigger_schema, trigger_name, event_object_schema, event_object_table, action_timing, \
                    string_agg(event_manipulation, ', ' ORDER BY event_manipulation) AS events, action_statement \
             FROM information_schema.triggers \
             WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') \
             GROUP BY trigger_schema, trigger_name, event_object_schema, event_object_table, action_timing, action_statement \
             ORDER BY trigger_schema, event_object_table, trigger_name",
        )
        .fetch_all(&self.pool())
        .await?;

        objects.extend(trigger_rows.iter().map(|row| {
            let schema = row.try_get::<String, _>(0).ok();
            let table_schema = row.try_get::<String, _>(2).ok();
            let table_name = row.try_get::<String, _>(3).ok();
            let timing = row.try_get::<String, _>(4).ok();
            let events = row.try_get::<String, _>(5).ok();
            let statement = row.try_get::<String, _>(6).ok();

            SchemaObjectInfo {
                create_date: None,
                name: row.get(1),
                schema,
                object_type: "TRIGGER".to_string(),
                related_table: match (table_schema, table_name.clone()) {
                    (Some(schema), Some(table)) => Some(format!("{schema}.{table}")),
                    (None, Some(table)) => Some(table),
                    _ => table_name,
                },
                definition: Some(format!(
                    "{}\n{}",
                    [
                        timing.unwrap_or_default(),
                        events.unwrap_or_default(),
                        "ON".to_string(),
                        row.try_get::<String, _>(3).unwrap_or_default(),
                    ]
                    .join(" ")
                    .trim(),
                    statement.unwrap_or_default().trim(),
                )),
            }
        }));

        let routine_rows: Vec<PgRow> = sqlx::query(
            "SELECT routine_schema, routine_name, routine_type, routine_definition \
             FROM information_schema.routines \
             WHERE routine_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY routine_schema, routine_type, routine_name",
        )
        .fetch_all(&self.pool())
        .await?;

        objects.extend(routine_rows.iter().map(|row| SchemaObjectInfo {
            create_date: None,
            name: row.get(1),
            schema: row.try_get::<String, _>(0).ok(),
            object_type: row.get::<String, _>(2).to_ascii_uppercase(),
            related_table: None,
            definition: row.try_get(3).ok(),
        }));

        Ok(objects)
    }

    pub(super) async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let (schema, table_name) = Self::split_schema_table(table);
        let pool = self.pool();
        let object_parameters = [
            compat_text_parameter(&table_name),
            compat_text_parameter(&schema),
        ];
        let column_sql = if self.db_type == DatabaseType::Vertica {
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, c.data_type, \
                    CASE WHEN c.is_identity THEN 'identity' ELSE NULL END AS extra, \
                    EXISTS ( \
                      SELECT 1 FROM v_catalog.primary_keys pk \
                      WHERE pk.table_schema = c.table_schema \
                        AND pk.table_name = c.table_name \
                        AND pk.column_name = c.column_name \
                    ) AS is_pk \
             FROM v_catalog.columns c \
             WHERE c.table_schema = $2 AND c.table_name = $1 \
             ORDER BY c.ordinal_position"
        } else {
            "WITH target AS ( \
               SELECT c.oid AS relid \
               FROM pg_class c \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = $2 AND c.relname = $1 \
               LIMIT 1 \
             ) \
             SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                    pg_get_expr(ad.adbin, ad.adrelid), \
                    format_type(a.atttypid, a.atttypmod), \
                    CASE \
                      WHEN a.attidentity = 'a' THEN 'generated always as identity' \
                      WHEN a.attidentity = 'd' THEN 'generated by default as identity' \
                      WHEN a.attgenerated = 's' THEN 'generated stored' \
                      ELSE NULL \
                    END AS extra, \
                    EXISTS ( \
                      SELECT 1 \
                      FROM pg_constraint con \
                      WHERE con.conrelid = a.attrelid \
                        AND con.contype = 'p' \
                        AND a.attnum = ANY(con.conkey) \
                    ) AS is_pk \
             FROM target t \
             JOIN pg_attribute a ON a.attrelid = t.relid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum"
        };

        let col_rows: Vec<PgRow> = timeout(
            Duration::from_secs(6),
            fetch_compat_positional_parameters(&pool, self.db_type, column_sql, &object_parameters),
        )
        .await
        .with_context(|| format!("Timed out loading columns for {}.{}", schema, table_name))??;

        let columns = col_rows
            .iter()
            .map(|row| {
                Ok(ColumnDetail {
                    name: row.get(0),
                    data_type: row.get(1),
                    is_nullable: Self::metadata_boolean(row, 2, self.db_type)?,
                    default_value: row.try_get(3).ok(),
                    column_type: row.try_get(4).ok(),
                    extra: row.try_get(5).ok(),
                    is_primary_key: Self::metadata_boolean(row, 6, self.db_type)?,
                    comment: None,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let idx_query = async {
            if self.db_type == DatabaseType::Vertica {
                return Ok::<Vec<PgRow>, anyhow::Error>(Vec::new());
            }
            fetch_compat_positional_parameters(
                &pool,
                self.db_type,
                "WITH target AS ( \
                   SELECT c.oid AS relid \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE n.nspname = $2 AND c.relname = $1 \
                   LIMIT 1 \
                 ) \
                 SELECT idx.relname, ix.indisunique, att.attname, am.amname \
                 FROM target t \
                 JOIN pg_index ix ON ix.indrelid = t.relid \
                 JOIN pg_class idx ON idx.oid = ix.indexrelid \
                 JOIN pg_am am ON am.oid = idx.relam \
                 JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) ON TRUE \
                 JOIN pg_attribute att ON att.attrelid = t.relid AND att.attnum = key.attnum \
                 ORDER BY idx.relname, key.ord",
                &object_parameters,
            )
            .await
        };

        let fk_sql = if self.db_type == DatabaseType::Vertica {
            "SELECT constraint_name, column_name, reference_table_name, reference_column_name, \
                    CAST(NULL AS VARCHAR) AS update_rule, CAST(NULL AS VARCHAR) AS delete_rule \
             FROM v_catalog.foreign_keys \
             WHERE table_schema = $2 AND table_name = $1 \
             ORDER BY constraint_name, ordinal_position"
        } else {
            "WITH target AS ( \
               SELECT c.oid AS relid \
               FROM pg_class c \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = $2 AND c.relname = $1 \
               LIMIT 1 \
             ) \
             SELECT con.conname, src_att.attname, ref_tbl.relname, ref_att.attname, \
                    CASE con.confupdtype \
                      WHEN 'a' THEN 'NO ACTION' \
                      WHEN 'r' THEN 'RESTRICT' \
                      WHEN 'c' THEN 'CASCADE' \
                      WHEN 'n' THEN 'SET NULL' \
                      WHEN 'd' THEN 'SET DEFAULT' \
                      ELSE NULL \
                    END AS update_rule, \
                    CASE con.confdeltype \
                      WHEN 'a' THEN 'NO ACTION' \
                      WHEN 'r' THEN 'RESTRICT' \
                      WHEN 'c' THEN 'CASCADE' \
                      WHEN 'n' THEN 'SET NULL' \
                      WHEN 'd' THEN 'SET DEFAULT' \
                      ELSE NULL \
                    END AS delete_rule \
             FROM target t \
             JOIN pg_constraint con ON con.conrelid = t.relid AND con.contype = 'f' \
             JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON TRUE \
             JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS dst(attnum, ord) ON dst.ord = src.ord \
             JOIN pg_attribute src_att ON src_att.attrelid = t.relid AND src_att.attnum = src.attnum \
             JOIN pg_class ref_tbl ON ref_tbl.oid = con.confrelid \
             JOIN pg_attribute ref_att ON ref_att.attrelid = con.confrelid AND ref_att.attnum = dst.attnum \
             ORDER BY con.conname, src.ord"
        };
        let fk_query =
            fetch_compat_positional_parameters(&pool, self.db_type, fk_sql, &object_parameters);

        let (idx_result, fk_result) = tokio::join!(
            timeout(Duration::from_secs(4), idx_query),
            timeout(Duration::from_secs(4), fk_query)
        );

        let idx_rows: Vec<PgRow> = match idx_result {
            Ok(Ok(rows)) => rows,
            Ok(Err(error)) => {
                warn!(
                    "Failed to load PostgreSQL indexes for {}.{}: {:?}",
                    schema, table_name, error
                );
                Vec::new()
            }
            Err(_) => {
                warn!(
                    "Timed out loading PostgreSQL indexes for {}.{}",
                    schema, table_name
                );
                Vec::new()
            }
        };

        let mut index_map: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for row in &idx_rows {
            let name: String = row.get(0);
            let is_unique: bool = row.get(1);
            let col: String = row.get(2);
            let idx_type: String = row.get(3);
            index_map
                .entry(name.clone())
                .and_modify(|idx| idx.columns.push(col.clone()))
                .or_insert(IndexInfo {
                    name,
                    columns: vec![col],
                    is_unique,
                    index_type: Some(idx_type),
                });
        }
        let indexes = index_map.into_values().collect();

        let fk_rows: Vec<PgRow> = match fk_result {
            Ok(Ok(rows)) => rows,
            Ok(Err(error)) => {
                warn!(
                    "Failed to load PostgreSQL foreign keys for {}.{}: {:?}",
                    schema, table_name, error
                );
                Vec::new()
            }
            Err(_) => {
                warn!(
                    "Timed out loading PostgreSQL foreign keys for {}.{}",
                    schema, table_name
                );
                Vec::new()
            }
        };

        let foreign_keys = fk_rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: row.get(0),
                column: row.get(1),
                referenced_table: row.get(2),
                referenced_column: row.get(3),
                on_update: row.try_get(4).ok(),
                on_delete: row.try_get(5).ok(),
            })
            .collect();

        let object_type_sql = if self.db_type == DatabaseType::Vertica {
            "SELECT table_type FROM ( \
               SELECT 'BASE TABLE' AS table_type, table_schema, table_name FROM v_catalog.tables \
               UNION ALL \
               SELECT 'VIEW' AS table_type, table_schema, table_name FROM v_catalog.views \
             ) AS objects \
             WHERE table_schema = $2 AND table_name = $1 LIMIT 1"
        } else {
            "SELECT table_type FROM information_schema.tables \
             WHERE table_schema = $2 AND table_name = $1 LIMIT 1"
        };
        let object_type = fetch_compat_positional_parameters(
            &pool,
            self.db_type,
            object_type_sql,
            &object_parameters,
        )
        .await?
        .into_iter()
        .next()
        .and_then(|row| row.try_get::<String, _>(0).ok());

        let view_sql = if self.db_type == DatabaseType::Vertica {
            "SELECT view_definition FROM v_catalog.views \
             WHERE table_schema = $2 AND table_name = $1 LIMIT 1"
        } else {
            "SELECT view_definition FROM information_schema.views \
             WHERE table_schema = $2 AND table_name = $1 LIMIT 1"
        };
        let view_definition =
            fetch_compat_positional_parameters(&pool, self.db_type, view_sql, &object_parameters)
                .await?
                .into_iter()
                .next()
                .and_then(|row| row.try_get::<String, _>(0).ok());

        let trigger_rows: Vec<PgRow> = if self.db_type == DatabaseType::Vertica {
            Vec::new()
        } else {
            fetch_compat_positional_parameters(
                &pool,
                self.db_type,
                "SELECT trigger_name, action_timing, \
                        string_agg(event_manipulation, ', ' ORDER BY event_manipulation) AS events, \
                        action_statement \
                 FROM information_schema.triggers \
                 WHERE event_object_schema = $2 AND event_object_table = $1 \
                 GROUP BY trigger_name, action_timing, action_statement \
                 ORDER BY trigger_name",
                &object_parameters,
            )
            .await?
        };

        let triggers = trigger_rows
            .iter()
            .map(|row| TriggerInfo {
                name: row.get(0),
                timing: row.try_get(1).ok(),
                event: row.try_get(2).ok(),
                related_table: Some(format!("{}.{}", schema, table_name)),
                definition: row.try_get(3).ok(),
            })
            .collect();

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            triggers,
            view_definition,
            object_type,
        })
    }

    pub(super) async fn get_table_columns_preview(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        let (schema, table_name) = Self::split_schema_table(table);
        let column_sql = if self.db_type == DatabaseType::Vertica {
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, c.data_type, \
                    CASE WHEN c.is_identity THEN 'identity' ELSE NULL END AS extra, \
                    EXISTS ( \
                      SELECT 1 FROM v_catalog.primary_keys pk \
                      WHERE pk.table_schema = c.table_schema \
                        AND pk.table_name = c.table_name \
                        AND pk.column_name = c.column_name \
                    ) AS is_pk \
             FROM v_catalog.columns c \
             WHERE c.table_schema = $2 AND c.table_name = $1 \
             ORDER BY c.ordinal_position"
        } else {
            "WITH target AS ( \
               SELECT c.oid AS relid \
               FROM pg_class c \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = $2 AND c.relname = $1 \
               LIMIT 1 \
             ) \
             SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                    pg_get_expr(ad.adbin, ad.adrelid), \
                    format_type(a.atttypid, a.atttypmod), \
                    CASE \
                      WHEN a.attidentity = 'a' THEN 'generated always as identity' \
                      WHEN a.attidentity = 'd' THEN 'generated by default as identity' \
                      WHEN a.attgenerated = 's' THEN 'generated stored' \
                      ELSE NULL \
                    END AS extra, \
                    EXISTS ( \
                      SELECT 1 \
                      FROM pg_constraint con \
                      WHERE con.conrelid = a.attrelid \
                        AND con.contype = 'p' \
                        AND a.attnum = ANY(con.conkey) \
                    ) AS is_pk \
             FROM target t \
             JOIN pg_attribute a ON a.attrelid = t.relid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum"
        };
        let parameters = [
            compat_text_parameter(&table_name),
            compat_text_parameter(&schema),
        ];
        let rows =
            fetch_compat_positional_parameters(&self.pool(), self.db_type, column_sql, &parameters)
                .await?;

        rows.iter()
            .map(|row| {
                Ok(ColumnDetail {
                    name: row.get(0),
                    data_type: row.get(1),
                    is_nullable: Self::metadata_boolean(row, 2, self.db_type)?,
                    default_value: row.try_get(3).ok(),
                    column_type: row.try_get(4).ok(),
                    extra: row.try_get(5).ok(),
                    is_primary_key: Self::metadata_boolean(row, 6, self.db_type)?,
                    comment: None,
                })
            })
            .collect::<Result<Vec<_>>>()
    }

    pub(super) async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let qualified_table = qualify_postgres_table_name(referenced_table, "public")?;
        let referenced_column_sql = quote_postgres_identifier(referenced_column)?;

        // Build label expression: COALESCE(display_col1, display_col2, ..., referenced_column)
        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|column| quote_postgres_identifier(column))
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            format!("COALESCE({})", cols)
        } else {
            referenced_column_sql.clone()
        };

        // Build the query - we always need the WHERE for search, so build the right query
        let pool = self.pool();

        if let Some(search_term) = search {
            let like_pattern = format!("%{}%", search_term);
            let cast_type = if self.db_type == DatabaseType::Vertica {
                "VARCHAR"
            } else {
                "TEXT"
            };
            let sql = format!(
                "SELECT {} AS value, {} AS label \
                 FROM {} \
                 WHERE CAST({} AS {}) ILIKE $1 \
                 ORDER BY {} \
                 LIMIT {}",
                referenced_column_sql,
                label_expr,
                qualified_table,
                referenced_column_sql,
                cast_type,
                referenced_column_sql,
                limit
            );
            let rows = fetch_compat_positional_parameters(
                &pool,
                self.db_type,
                &sql,
                &[compat_text_parameter(&like_pattern)],
            )
            .await?;
            return rows
                .into_iter()
                .map(|row| {
                    Ok(LookupValue {
                        value: {
                            let data_type = row.column(0).type_info().name().to_ascii_uppercase();
                            Self::pg_cell_to_json(self.db_type, &row, 0, Some(&data_type))?
                        },
                        label: row.try_get(1)?,
                    })
                })
                .collect();
        }

        let sql = format!(
            "SELECT {} AS value, {} AS label \
             FROM {} \
             ORDER BY {} \
             LIMIT {}",
            referenced_column_sql, label_expr, qualified_table, referenced_column_sql, limit
        );
        let rows = pool.fetch_all(CompatQuery::new(self.db_type, &sql)).await?;
        rows.into_iter()
            .map(|row| {
                Ok(LookupValue {
                    value: {
                        let data_type = row.column(0).type_info().name().to_ascii_uppercase();
                        Self::pg_cell_to_json(self.db_type, &row, 0, Some(&data_type))?
                    },
                    label: row.try_get(1)?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{inline_vertica_parameterized_query, inline_vertica_parameters, CompatQuery};
    use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType};
    use crate::database::postgres::PostgresDriver;
    use serde_json::json;
    use sqlx::{Execute, Postgres, QueryBuilder};

    fn parameter(
        name: &str,
        value: serde_json::Value,
        data_type: QueryParameterType,
    ) -> QueryParameter {
        QueryParameter {
            name: name.to_string(),
            value,
            data_type,
        }
    }

    #[test]
    fn vertica_simple_query_has_no_prepared_argument_buffer() {
        let mut simple = CompatQuery::new(DatabaseType::Vertica, "SELECT 1");
        assert!(simple.take_arguments().unwrap().is_none());

        let mut prepared = CompatQuery::new(DatabaseType::PostgreSQL, "SELECT 1");
        assert!(prepared.take_arguments().unwrap().is_some());
    }

    #[test]
    fn vertica_inlining_escapes_text_and_preserves_sql_literals_and_unicode() {
        let inlined = inline_vertica_parameters(
            "SELECT $1, '$1', \"$1\" -- $1\n/* $1 */",
            &[parameter(
                "value",
                json!("O'Reilly 😊; SELECT $2"),
                QueryParameterType::Text,
            )],
        )
        .unwrap();
        assert_eq!(
            inlined,
            "SELECT 'O''Reilly 😊; SELECT $2', '$1', \"$1\" -- $1\n/* $1 */"
        );
    }

    #[test]
    fn vertica_named_parameters_repeat_without_touching_dollar_quotes() {
        let inlined = inline_vertica_parameterized_query(
            "SELECT $tag1$ :ignored $1 $tag1$, :value, :value, :enabled",
            &[
                parameter("value", json!("real"), QueryParameterType::Text),
                parameter("enabled", json!(true), QueryParameterType::Boolean),
            ],
        )
        .unwrap();
        assert_eq!(
            inlined,
            "SELECT $tag1$ :ignored $1 $tag1$, 'real', 'real', TRUE"
        );
    }

    #[test]
    fn vertica_inlining_rejects_positional_mismatches_and_nul() {
        let text = || parameter("value", json!("x"), QueryParameterType::Text);
        assert!(inline_vertica_parameters("SELECT $2", &[text()]).is_err());
        assert!(inline_vertica_parameters("SELECT $1", &[text(), text()]).is_err());
        assert!(inline_vertica_parameters("SELECT $0", &[]).is_err());
        assert!(inline_vertica_parameters(
            "SELECT $1",
            &[parameter(
                "value",
                json!("bad\0text"),
                QueryParameterType::Text
            )]
        )
        .is_err());
    }

    #[test]
    fn vertica_table_values_are_literalized_but_postgres_values_remain_bound() {
        let mut vertica = QueryBuilder::<Postgres>::new("SELECT ");
        PostgresDriver::push_bound_value(
            DatabaseType::Vertica,
            &mut vertica,
            &json!("x' OR 1=1 --"),
        )
        .unwrap();
        assert_eq!(vertica.sql(), "SELECT 'x'' OR 1=1 --'");

        let mut postgres = QueryBuilder::<Postgres>::new("SELECT ");
        PostgresDriver::push_bound_value(
            DatabaseType::PostgreSQL,
            &mut postgres,
            &json!("x' OR 1=1 --"),
        )
        .unwrap();
        assert_eq!(postgres.sql(), "SELECT $1");
    }
}
