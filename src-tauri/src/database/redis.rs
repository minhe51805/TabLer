use super::driver::DatabaseDriver;
use super::models::*;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use redis::{
    cmd, Client, Connection as RedisConnection, IntoConnectionInfo,
    RedisConnectionInfo as RedisAuthInfo, Value as RedisValue,
};
use serde_json::Value as JsonValue;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::task;

pub struct RedisDriver {
    connection: Arc<Mutex<RedisConnection>>,
    current_db: Arc<Mutex<i64>>,
}

impl RedisDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        if config.use_ssl {
            return Err(anyhow!(
                "Redis TLS connections are not enabled in this build yet."
            ));
        }

        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Redis host is required")?
            .to_string();
        let port = config.port.unwrap_or(6379);
        let db_index = Self::initial_database_index(config)?;

        let mut redis_settings = RedisAuthInfo::default().set_db(db_index);
        if let Some(username) = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            redis_settings = redis_settings.set_username(username);
        }
        if let Some(password) = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            redis_settings = redis_settings.set_password(password);
        }

        let connection_info = (host, port)
            .into_connection_info()
            .context("Failed to prepare Redis connection info")?
            .set_redis_settings(redis_settings);

        let connection = task::spawn_blocking(move || -> Result<RedisConnection> {
            let client =
                Client::open(connection_info).context("Failed to initialize Redis client")?;
            let mut connection = client
                .get_connection()
                .context("Failed to open the Redis connection")?;
            let _: String = cmd("PING")
                .query(&mut connection)
                .context("Redis ping failed during connect")?;
            Ok(connection)
        })
        .await
        .map_err(|_| anyhow!("Redis connection task failed unexpectedly"))??;

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            current_db: Arc::new(Mutex::new(db_index)),
        })
    }

    async fn with_connection<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut RedisConnection, &mut i64) -> Result<T> + Send + 'static,
    {
        let connection = self.connection.clone();
        let current_db = self.current_db.clone();
        task::spawn_blocking(move || {
            let mut connection_guard = connection
                .lock()
                .map_err(|_| anyhow!("Redis connection lock was poisoned"))?;
            let mut db_guard = current_db
                .lock()
                .map_err(|_| anyhow!("Redis database state lock was poisoned"))?;
            operation(&mut connection_guard, &mut db_guard)
        })
        .await
        .map_err(|_| anyhow!("Redis background task failed unexpectedly"))?
    }

    async fn with_selected_database<T, F>(&self, database: Option<&str>, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut RedisConnection, i64) -> Result<T> + Send + 'static,
    {
        let requested_db = database.map(Self::parse_database_index).transpose()?;

        self.with_connection(move |connection, current_db| {
            let target_db = requested_db.unwrap_or(*current_db);
            Self::ensure_database_selected(connection, current_db, target_db)?;
            operation(connection, target_db)
        })
        .await
    }

    fn ensure_database_selected(
        connection: &mut RedisConnection,
        current_db: &mut i64,
        target_db: i64,
    ) -> Result<()> {
        if *current_db == target_db {
            return Ok(());
        }

        let _: () = cmd("SELECT")
            .arg(target_db)
            .query(connection)
            .with_context(|| format!("Failed to switch Redis database to db{target_db}"))?;
        *current_db = target_db;
        Ok(())
    }

    fn initial_database_index(config: &ConnectionConfig) -> Result<i64> {
        if let Some(raw_value) = config
            .additional_fields
            .get("redis_database")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Self::parse_database_index(raw_value);
        }

        let legacy_value = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        match legacy_value {
            Some(value) => Self::parse_database_index(value).or(Ok(0)),
            None => Ok(0),
        }
    }

    fn parse_database_index(raw_value: &str) -> Result<i64> {
        let trimmed = raw_value.trim();
        if trimmed.is_empty() {
            return Ok(0);
        }

        let without_prefix = trimmed
            .strip_prefix("db")
            .or_else(|| trimmed.strip_prefix("DB"))
            .unwrap_or(trimmed);
        let db_index = without_prefix.parse::<i64>().with_context(|| {
            format!("Redis database index must be a number, received: {trimmed}")
        })?;
        if db_index < 0 {
            return Err(anyhow!("Redis database index cannot be negative"));
        }
        Ok(db_index)
    }

    fn database_label(db_index: i64) -> String {
        format!("db{db_index}")
    }
}

#[async_trait]
impl DatabaseDriver for RedisDriver {
    async fn ping(&self) -> Result<()> {
        self.with_connection(|connection, _| {
            let _: String = cmd("PING").query(connection).context("Redis ping failed")?;
            Ok(())
        })
        .await
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        self.with_connection(|connection, current_db| {
            let current_label = Self::database_label(*current_db);
            let info_result = cmd("INFO").arg("keyspace").query::<String>(connection);

            let mut databases = info_result
                .ok()
                .map(|info| {
                    info.lines()
                        .filter_map(|line| {
                            let trimmed = line.trim();
                            if !trimmed.starts_with("db") {
                                return None;
                            }

                            let (name, metrics) = trimmed.split_once(':')?;
                            let key_count = metrics
                                .split(',')
                                .find_map(|pair| pair.strip_prefix("keys="))
                                .and_then(|value| value.parse::<i64>().ok());

                            Some(DatabaseInfo {
                                name: name.to_string(),
                                size: key_count.map(|value| format!("{value} keys")),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            if !databases
                .iter()
                .any(|database| database.name == current_label)
            {
                databases.push(DatabaseInfo {
                    name: current_label,
                    size: None,
                });
            }

            databases.sort_by(|left, right| left.name.cmp(&right.name));
            Ok(databases)
        })
        .await
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        self.with_selected_database(database, |connection, db_index| {
            let tables = Self::scan_keys(connection)?
                .into_iter()
                .map(|key| TableInfo {
                    name: key,
                    schema: Some(Self::database_label(db_index)),
                    table_type: "KEY".to_string(),
                    row_count: None,
                    engine: Some("Redis".to_string()),
                })
                .collect::<Vec<_>>();

            Ok(tables)
        })
        .await
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        Ok(Vec::new())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_name = table.trim().to_string();
        self.with_selected_database(database, move |connection, _| {
            let key_type = Self::key_type(connection, &table_name)?;
            if key_type == "none" {
                return Err(anyhow!("Redis key '{}' was not found", table_name));
            }
            Ok(Self::build_structure_for_key_type(&key_type))
        })
        .await
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let raw_script = sql.to_string();
        let commands = Self::parse_command_lines(sql)?;

        self.with_connection(move |connection, current_db| {
            let start = Instant::now();
            let mut last_result = Self::build_query_result(
                vec![Self::column("result", "TEXT")],
                Vec::new(),
                0,
                raw_script.clone(),
                0,
            );
            let mut total_affected = 0u64;

            for tokens in commands {
                let command_name = tokens
                    .first()
                    .cloned()
                    .ok_or_else(|| anyhow!("Redis command cannot be empty"))?;
                let mut redis_command = cmd(&command_name);
                for argument in tokens.iter().skip(1) {
                    redis_command.arg(argument);
                }

                let value = redis_command
                    .query::<RedisValue>(connection)
                    .with_context(|| format!("Redis command failed: {}", tokens.join(" ")))?;

                if command_name.eq_ignore_ascii_case("SELECT") {
                    if let Some(target_db) = tokens.get(1) {
                        *current_db = Self::parse_database_index(target_db)?;
                    }
                }

                let affected_rows = Self::affected_rows_for_command(&command_name, &value);
                total_affected += affected_rows;
                last_result = Self::build_command_query_result(
                    &command_name,
                    &tokens,
                    value,
                    start.elapsed().as_millis(),
                    raw_script.clone(),
                    affected_rows,
                );
            }

            last_result.affected_rows = total_affected;
            last_result.execution_time_ms = start.elapsed().as_millis();
            Ok(last_result)
        })
        .await
    }

    async fn get_table_data(
        &self,
        table: &str,
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let table_name = table.trim().to_string();
        let order_by = order_by.map(str::to_string);
        let order_dir = order_dir.map(str::to_string);
        let filter = filter.map(str::to_string);
        self.with_selected_database(database, move |connection, _| {
            let start = Instant::now();
            let key_type = Self::key_type(connection, &table_name)?;
            if key_type == "none" {
                return Err(anyhow!("Redis key '{}' was not found", table_name));
            }

            let (columns, rows) = match key_type.as_str() {
                "string" => {
                    let value = cmd("GET")
                        .arg(&table_name)
                        .query::<Option<Vec<u8>>>(connection)
                        .with_context(|| {
                            format!("Failed to fetch Redis string value for {}", table_name)
                        })?;
                    let rows = value
                        .map(|bytes| {
                            vec![vec![
                                JsonValue::String(table_name.clone()),
                                JsonValue::String(Self::bytes_to_string(&bytes)),
                            ]]
                        })
                        .unwrap_or_default();
                    (
                        vec![Self::column("key", "TEXT"), Self::column("value", "TEXT")],
                        rows,
                    )
                }
                "hash" => (
                    vec![Self::column("field", "TEXT"), Self::column("value", "TEXT")],
                    Self::fetch_hash_rows(connection, &table_name)?,
                ),
                "list" => (
                    vec![
                        Self::column("index", "INTEGER"),
                        Self::column("value", "TEXT"),
                    ],
                    Self::fetch_list_rows(connection, &table_name)?,
                ),
                "set" => (
                    vec![Self::column("member", "TEXT")],
                    Self::fetch_set_rows(connection, &table_name)?,
                ),
                "zset" => (
                    vec![
                        Self::column("member", "TEXT"),
                        Self::column("score", "DOUBLE"),
                    ],
                    Self::fetch_zset_rows(connection, &table_name)?,
                ),
                "stream" => (
                    vec![Self::column("id", "TEXT"), Self::column("payload", "JSON")],
                    Self::fetch_stream_rows(connection, &table_name)?,
                ),
                _ => (
                    vec![Self::column("key", "TEXT"), Self::column("value", "TEXT")],
                    vec![vec![
                        JsonValue::String(table_name.clone()),
                        JsonValue::String(format!("Unsupported Redis key type: {key_type}")),
                    ]],
                ),
            };

            let mut filtered_rows = Self::maybe_filter_rows(rows, filter.as_deref());
            Self::sort_rows(
                &mut filtered_rows,
                &columns,
                order_by.as_deref(),
                order_dir.as_deref(),
            );
            let paged_rows = Self::apply_offset_and_limit(filtered_rows, offset, limit);

            Ok(Self::build_query_result(
                columns,
                paged_rows,
                start.elapsed().as_millis(),
                format!("REDIS {} {}", key_type.to_ascii_uppercase(), table_name),
                0,
            ))
        })
        .await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let table_name = table.trim().to_string();
        self.with_selected_database(database, move |connection, _| {
            let key_type = Self::key_type(connection, &table_name)?;
            let count = match key_type.as_str() {
                "string" => cmd("EXISTS")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| format!("Failed to count Redis key {}", table_name))?,
                "hash" => cmd("HLEN")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| {
                        format!("Failed to count Redis hash entries for {}", table_name)
                    })?,
                "list" => cmd("LLEN")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| {
                        format!("Failed to count Redis list entries for {}", table_name)
                    })?,
                "set" => cmd("SCARD")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| {
                        format!("Failed to count Redis set members for {}", table_name)
                    })?,
                "zset" => cmd("ZCARD")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| {
                        format!(
                            "Failed to count Redis sorted-set members for {}",
                            table_name
                        )
                    })?,
                "stream" => cmd("XLEN")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| {
                        format!("Failed to count Redis stream entries for {}", table_name)
                    })?,
                "none" => 0,
                _ => cmd("EXISTS")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| format!("Failed to count Redis key {}", table_name))?,
            };

            Ok(count)
        })
        .await
    }

    async fn count_null_values(
        &self,
        _table: &str,
        _database: Option<&str>,
        _column: &str,
    ) -> Result<i64> {
        Ok(0)
    }

    async fn update_table_cell(&self, _request: &TableCellUpdateRequest) -> Result<u64> {
        Err(anyhow!(
            "Redis key projections are read-only in this build. Use the Redis CLI tab to mutate values."
        ))
    }

    async fn delete_table_rows(&self, _request: &TableRowDeleteRequest) -> Result<u64> {
        Err(anyhow!(
            "Redis key projections are read-only in this build. Use the Redis CLI tab to mutate values."
        ))
    }

    async fn insert_table_row(&self, _request: &TableRowInsertRequest) -> Result<u64> {
        Err(anyhow!(
            "Redis key projections are read-only in this build. Use the Redis CLI tab to create values."
        ))
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        self.with_selected_database(Some(database), |_connection, _| Ok(()))
            .await
    }

    async fn get_foreign_key_lookup_values(
        &self,
        _referenced_table: &str,
        _referenced_column: &str,
        _display_columns: &[&str],
        _search: Option<&str>,
        _limit: u32,
    ) -> Result<Vec<LookupValue>> {
        Ok(Vec::new())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db
            .lock()
            .ok()
            .map(|guard| Self::database_label(*guard))
    }

    fn driver_name(&self) -> &str {
        "redis"
    }
}

#[cfg(test)]
mod tests {
    use super::RedisDriver;
    use redis::Value as RedisValue;

    #[test]
    fn parses_redis_database_index_from_plain_number() {
        assert_eq!(RedisDriver::parse_database_index("0").unwrap(), 0);
        assert_eq!(RedisDriver::parse_database_index("12").unwrap(), 12);
    }

    #[test]
    fn parses_redis_database_index_from_db_label() {
        assert_eq!(RedisDriver::parse_database_index("db0").unwrap(), 0);
        assert_eq!(RedisDriver::parse_database_index("DB7").unwrap(), 7);
    }

    #[test]
    fn rejects_negative_redis_database_index() {
        assert!(RedisDriver::parse_database_index("-1").is_err());
    }

    #[test]
    fn parses_redis_cli_command_lines_with_quotes() {
        let commands =
            RedisDriver::parse_command_lines("SET greeting \"hello world\"\nPING").unwrap();
        assert_eq!(
            commands,
            vec![
                vec![
                    "SET".to_string(),
                    "greeting".to_string(),
                    "hello world".to_string()
                ],
                vec!["PING".to_string()],
            ]
        );
    }

    #[test]
    fn builds_pair_rows_for_hgetall_like_responses() {
        let value = RedisValue::Array(vec![
            RedisValue::BulkString(b"field_a".to_vec()),
            RedisValue::BulkString(b"value_a".to_vec()),
            RedisValue::BulkString(b"field_b".to_vec()),
            RedisValue::BulkString(b"value_b".to_vec()),
        ]);

        let (_, rows) = RedisDriver::rows_from_pair_array(value, "field", "value").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0], serde_json::Value::String("field_a".to_string()));
        assert_eq!(rows[0][1], serde_json::Value::String("value_a".to_string()));
    }
}
