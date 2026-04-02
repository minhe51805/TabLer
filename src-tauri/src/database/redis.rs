use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use redis::{
    cmd, Client, Connection as RedisConnection, IntoConnectionInfo,
    RedisConnectionInfo as RedisAuthInfo, Value as RedisValue,
};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::cmp::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::task;

const REDIS_SCAN_BATCH_SIZE: usize = 250;
const REDIS_MAX_DISCOVERED_KEYS: usize = 1000;

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
            let client = Client::open(connection_info).context("Failed to initialize Redis client")?;
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

    fn bytes_to_string(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).to_string()
    }

    fn redis_value_to_json(value: RedisValue) -> JsonValue {
        match value {
            RedisValue::Nil => JsonValue::Null,
            RedisValue::Int(value) => JsonValue::from(value),
            RedisValue::BulkString(bytes) => JsonValue::String(Self::bytes_to_string(&bytes)),
            RedisValue::Array(values) => JsonValue::Array(
                values
                    .into_iter()
                    .map(Self::redis_value_to_json)
                    .collect::<Vec<_>>(),
            ),
            RedisValue::SimpleString(value) => JsonValue::String(value),
            RedisValue::Okay => JsonValue::String("OK".to_string()),
            RedisValue::Map(entries) => {
                let mut object = JsonMap::new();
                let mut all_keys_are_unique_strings = true;

                for (key, value) in entries.iter() {
                    match Self::redis_value_to_json(key.clone()) {
                        JsonValue::String(key_text) if !object.contains_key(&key_text) => {
                            object.insert(key_text, Self::redis_value_to_json(value.clone()));
                        }
                        _ => {
                            all_keys_are_unique_strings = false;
                            break;
                        }
                    }
                }

                if all_keys_are_unique_strings {
                    JsonValue::Object(object)
                } else {
                    JsonValue::Array(
                        entries
                            .into_iter()
                            .map(|(key, value)| {
                                JsonValue::Object(
                                    [
                                        ("key".to_string(), Self::redis_value_to_json(key)),
                                        ("value".to_string(), Self::redis_value_to_json(value)),
                                    ]
                                    .into_iter()
                                    .collect(),
                                )
                            })
                            .collect::<Vec<_>>(),
                    )
                }
            }
            RedisValue::Attribute { data, .. } => Self::redis_value_to_json(*data),
            RedisValue::Set(values) => JsonValue::Array(
                values
                    .into_iter()
                    .map(Self::redis_value_to_json)
                    .collect::<Vec<_>>(),
            ),
            RedisValue::Double(value) => JsonValue::from(value),
            RedisValue::Boolean(value) => JsonValue::from(value),
            RedisValue::VerbatimString { text, .. } => JsonValue::String(text),
            RedisValue::BigNumber(value) => JsonValue::String(format!("{value:?}")),
            RedisValue::Push { data, .. } => JsonValue::Array(
                data.into_iter()
                    .map(Self::redis_value_to_json)
                    .collect::<Vec<_>>(),
            ),
            RedisValue::ServerError(error) => JsonValue::String(error.to_string()),
            _ => JsonValue::String(format!("{value:?}")),
        }
    }

    fn json_to_grid_cell(value: JsonValue) -> JsonValue {
        match value {
            JsonValue::Array(_) | JsonValue::Object(_) => JsonValue::String(value.to_string()),
            other => other,
        }
    }

    fn redis_value_to_cell(value: RedisValue) -> JsonValue {
        Self::json_to_grid_cell(Self::redis_value_to_json(value))
    }

    fn column(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            is_primary_key: false,
            max_length: None,
            default_value: None,
        }
    }

    fn detail(name: &str, data_type: &str, extra: Option<&str>) -> ColumnDetail {
        ColumnDetail {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            is_primary_key: false,
            default_value: None,
            extra: extra.map(str::to_string),
            column_type: Some(data_type.to_string()),
            comment: None,
        }
    }

    fn empty_structure(object_type: &str, columns: Vec<ColumnDetail>) -> TableStructure {
        TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some(object_type.to_string()),
        }
    }

    fn compare_cells(left: &JsonValue, right: &JsonValue) -> Ordering {
        match (left.as_f64(), right.as_f64()) {
            (Some(left_number), Some(right_number)) => left_number
                .partial_cmp(&right_number)
                .unwrap_or(Ordering::Equal),
            _ => left.to_string().cmp(&right.to_string()),
        }
    }

    fn sort_rows(
        rows: &mut [Vec<JsonValue>],
        columns: &[ColumnInfo],
        order_by: Option<&str>,
        order_dir: Option<&str>,
    ) {
        let Some(order_name) = order_by.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        let Some(column_index) = columns.iter().position(|column| column.name == order_name) else {
            return;
        };

        let descending = matches!(order_dir, Some(value) if value.eq_ignore_ascii_case("DESC"));
        rows.sort_by(|left, right| {
            let left_value = left.get(column_index).unwrap_or(&JsonValue::Null);
            let right_value = right.get(column_index).unwrap_or(&JsonValue::Null);
            let ordering = Self::compare_cells(left_value, right_value);
            if descending {
                ordering.reverse()
            } else {
                ordering
            }
        });
    }

    fn apply_offset_and_limit(
        mut rows: Vec<Vec<JsonValue>>,
        offset: u64,
        limit: u64,
    ) -> Vec<Vec<JsonValue>> {
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        let length = usize::try_from(limit).unwrap_or(usize::MAX);
        if start >= rows.len() {
            return Vec::new();
        }
        rows.drain(0..start);
        if rows.len() > length {
            rows.truncate(length);
        }
        rows
    }

    fn build_query_result(
        columns: Vec<ColumnInfo>,
        mut rows: Vec<Vec<JsonValue>>,
        elapsed_ms: u128,
        query: String,
        affected_rows: u64,
    ) -> QueryResult {
        let truncated = rows.len() > MAX_QUERY_RESULT_ROWS;
        if truncated {
            rows.truncate(MAX_QUERY_RESULT_ROWS);
        }

        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed_ms,
            query,
            sandboxed: false,
            truncated,
        }
    }

    fn rows_from_pair_array(
        value: RedisValue,
        left_name: &str,
        right_name: &str,
    ) -> Option<(Vec<ColumnInfo>, Vec<Vec<JsonValue>>)> {
        let RedisValue::Array(values) = value else {
            return None;
        };

        let mut rows = Vec::new();
        let mut chunks = values.into_iter();
        while let Some(left) = chunks.next() {
            let right = chunks.next().unwrap_or(RedisValue::Nil);
            rows.push(vec![Self::redis_value_to_cell(left), Self::redis_value_to_cell(right)]);
        }

        Some((
            vec![Self::column(left_name, "TEXT"), Self::column(right_name, "TEXT")],
            rows,
        ))
    }

    fn build_generic_query_table(value: RedisValue) -> (Vec<ColumnInfo>, Vec<Vec<JsonValue>>) {
        let json = Self::redis_value_to_json(value);

        match json {
            JsonValue::Array(items) => {
                if items.iter().all(|item| matches!(item, JsonValue::Object(_))) {
                    let mut keys = Vec::<String>::new();
                    for item in &items {
                        if let JsonValue::Object(map) = item {
                            for key in map.keys() {
                                if !keys.iter().any(|existing| existing == key) {
                                    keys.push(key.clone());
                                }
                            }
                        }
                    }

                    let columns = keys
                        .iter()
                        .map(|key| Self::column(key, "TEXT"))
                        .collect::<Vec<_>>();
                    let rows = items
                        .into_iter()
                        .map(|item| match item {
                            JsonValue::Object(map) => keys
                                .iter()
                                .map(|key| {
                                    Self::json_to_grid_cell(
                                        map.get(key).cloned().unwrap_or(JsonValue::Null),
                                    )
                                })
                                .collect::<Vec<_>>(),
                            _ => Vec::new(),
                        })
                        .collect::<Vec<_>>();
                    return (columns, rows);
                }

                if items.iter().all(|item| matches!(item, JsonValue::Array(_))) {
                    let width = items
                        .iter()
                        .filter_map(|item| item.as_array().map(Vec::len))
                        .max()
                        .unwrap_or(0);
                    let columns = (0..width)
                        .map(|index| Self::column(&format!("col{}", index + 1), "TEXT"))
                        .collect::<Vec<_>>();
                    let rows = items
                        .into_iter()
                        .map(|item| match item {
                            JsonValue::Array(values) => (0..width)
                                .map(|index| {
                                    Self::json_to_grid_cell(
                                        values.get(index).cloned().unwrap_or(JsonValue::Null),
                                    )
                                })
                                .collect::<Vec<_>>(),
                            _ => Vec::new(),
                        })
                        .collect::<Vec<_>>();
                    return (columns, rows);
                }

                (
                    vec![Self::column("value", "TEXT")],
                    items
                        .into_iter()
                        .map(|value| vec![Self::json_to_grid_cell(value)])
                        .collect::<Vec<_>>(),
                )
            }
            JsonValue::Object(map) => {
                let keys = map.keys().cloned().collect::<Vec<_>>();
                let columns = keys
                    .iter()
                    .map(|key| Self::column(key, "TEXT"))
                    .collect::<Vec<_>>();
                let row = keys
                    .iter()
                    .map(|key| {
                        Self::json_to_grid_cell(map.get(key).cloned().unwrap_or(JsonValue::Null))
                    })
                    .collect::<Vec<_>>();
                (columns, vec![row])
            }
            other => (
                vec![Self::column("result", "TEXT")],
                vec![vec![Self::json_to_grid_cell(other)]],
            ),
        }
    }

    fn build_command_query_result(
        command_name: &str,
        command_tokens: &[String],
        value: RedisValue,
        elapsed_ms: u128,
        query: String,
        affected_rows: u64,
    ) -> QueryResult {
        let upper_name = command_name.to_ascii_uppercase();

        let (columns, rows) = match upper_name.as_str() {
            "HGETALL" => Self::rows_from_pair_array(value.clone(), "field", "value")
                .unwrap_or_else(|| Self::build_generic_query_table(value)),
            "ZRANGE" | "ZREVRANGE" if command_tokens.iter().any(|token| token.eq_ignore_ascii_case("WITHSCORES")) => {
                Self::rows_from_pair_array(value.clone(), "member", "score")
                    .unwrap_or_else(|| Self::build_generic_query_table(value))
            }
            "SCAN" | "SSCAN" => match value {
                RedisValue::Array(mut outer) if outer.len() == 2 => {
                    let cursor = Self::redis_value_to_cell(outer.remove(0));
                    let rows = match outer.remove(0) {
                        RedisValue::Array(values) | RedisValue::Set(values) => values
                            .into_iter()
                            .map(|item| vec![cursor.clone(), Self::redis_value_to_cell(item)])
                            .collect::<Vec<_>>(),
                        other => vec![vec![cursor, Self::redis_value_to_cell(other)]],
                    };
                    (
                        vec![Self::column("cursor", "TEXT"), Self::column("value", "TEXT")],
                        rows,
                    )
                }
                other => Self::build_generic_query_table(other),
            },
            "HSCAN" | "ZSCAN" => match value {
                RedisValue::Array(mut outer) if outer.len() == 2 => {
                    let cursor = Self::redis_value_to_cell(outer.remove(0));
                    let payload = outer.remove(0);
                    let pair_names = if upper_name == "HSCAN" {
                        ("field", "value")
                    } else {
                        ("member", "score")
                    };
                    if let Some((_, pair_rows)) =
                        Self::rows_from_pair_array(payload, pair_names.0, pair_names.1)
                    {
                        let rows = pair_rows
                            .into_iter()
                            .map(|mut row| {
                                row.insert(0, cursor.clone());
                                row
                            })
                            .collect::<Vec<_>>();
                        (
                            vec![
                                Self::column("cursor", "TEXT"),
                                Self::column(pair_names.0, "TEXT"),
                                Self::column(pair_names.1, "TEXT"),
                            ],
                            rows,
                        )
                    } else {
                        (
                            vec![Self::column("cursor", "TEXT"), Self::column("value", "TEXT")],
                            vec![vec![cursor, JsonValue::Null]],
                        )
                    }
                }
                other => Self::build_generic_query_table(other),
            },
            "XRANGE" | "XREVRANGE" => match value {
                RedisValue::Array(entries) => {
                    let rows = entries
                        .into_iter()
                        .filter_map(|entry| match entry {
                            RedisValue::Array(mut parts) if parts.len() == 2 => {
                                let id = Self::redis_value_to_cell(parts.remove(0));
                                let payload = parts.remove(0);
                                Some(vec![
                                    id,
                                    JsonValue::String(Self::redis_value_to_json(payload).to_string()),
                                ])
                            }
                            _ => None,
                        })
                        .collect::<Vec<_>>();
                    (
                        vec![Self::column("id", "TEXT"), Self::column("payload", "JSON")],
                        rows,
                    )
                }
                other => Self::build_generic_query_table(other),
            },
            _ => Self::build_generic_query_table(value),
        };

        Self::build_query_result(columns, rows, elapsed_ms, query, affected_rows)
    }

    fn affected_rows_for_command(command_name: &str, value: &RedisValue) -> u64 {
        let normalized = command_name.to_ascii_uppercase();
        let likely_mutation = matches!(
            normalized.as_str(),
            "SET"
                | "DEL"
                | "HSET"
                | "HDEL"
                | "LPUSH"
                | "RPUSH"
                | "LSET"
                | "LREM"
                | "SADD"
                | "SREM"
                | "ZADD"
                | "ZREM"
                | "XADD"
                | "XDEL"
                | "APPEND"
                | "EXPIRE"
                | "PERSIST"
                | "INCR"
                | "DECR"
                | "MSET"
                | "MSETNX"
                | "SELECT"
        );

        if !likely_mutation {
            return 0;
        }

        match value {
            RedisValue::Int(value) if *value > 0 => *value as u64,
            RedisValue::Okay => 1,
            RedisValue::SimpleString(value) if value.eq_ignore_ascii_case("OK") => 1,
            _ => 0,
        }
    }

    fn parse_command_lines(script: &str) -> Result<Vec<Vec<String>>> {
        let mut commands = Vec::new();

        for raw_line in script.lines() {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("--") {
                continue;
            }

            let normalized = trimmed.trim_end_matches(';').trim();
            if normalized.is_empty() {
                continue;
            }

            let tokens = shlex::split(normalized)
                .ok_or_else(|| anyhow!("Could not parse Redis command: {normalized}"))?;
            if tokens.is_empty() {
                continue;
            }

            let upper_name = tokens[0].to_ascii_uppercase();
            if matches!(
                upper_name.as_str(),
                "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "MONITOR" | "QUIT"
            ) {
                return Err(anyhow!(
                    "{upper_name} is not supported from the workspace Redis CLI tab."
                ));
            }

            commands.push(tokens);
        }

        if commands.is_empty() {
            return Err(anyhow!("Redis command input is empty"));
        }

        Ok(commands)
    }

    fn key_type(connection: &mut RedisConnection, table: &str) -> Result<String> {
        let key_type = cmd("TYPE")
            .arg(table)
            .query::<String>(connection)
            .with_context(|| format!("Failed to inspect Redis key type for {table}"))?;
        Ok(key_type.to_ascii_lowercase())
    }

    fn scan_keys(connection: &mut RedisConnection) -> Result<Vec<String>> {
        let mut cursor = 0u64;
        let mut keys = Vec::new();

        loop {
            let (next_cursor, batch): (u64, Vec<Vec<u8>>) = cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg("*")
                .arg("COUNT")
                .arg(REDIS_SCAN_BATCH_SIZE)
                .query(connection)
                .context("Redis key scan failed")?;

            keys.extend(batch.into_iter().map(|value| Self::bytes_to_string(&value)));
            if next_cursor == 0 || keys.len() >= REDIS_MAX_DISCOVERED_KEYS {
                break;
            }
            cursor = next_cursor;
        }

        keys.sort_unstable();
        keys.dedup();
        if keys.len() > REDIS_MAX_DISCOVERED_KEYS {
            keys.truncate(REDIS_MAX_DISCOVERED_KEYS);
        }
        Ok(keys)
    }

    fn build_structure_for_key_type(key_type: &str) -> TableStructure {
        match key_type {
            "string" => Self::empty_structure(
                "REDIS STRING",
                vec![
                    Self::detail("key", "TEXT", Some("Redis key name")),
                    Self::detail("value", "TEXT", Some("String value")),
                ],
            ),
            "hash" => Self::empty_structure(
                "REDIS HASH",
                vec![
                    Self::detail("field", "TEXT", Some("Hash field name")),
                    Self::detail("value", "TEXT", Some("Hash field value")),
                ],
            ),
            "list" => Self::empty_structure(
                "REDIS LIST",
                vec![
                    Self::detail("index", "INTEGER", Some("List item index")),
                    Self::detail("value", "TEXT", Some("List item value")),
                ],
            ),
            "set" => Self::empty_structure(
                "REDIS SET",
                vec![Self::detail("member", "TEXT", Some("Set member"))],
            ),
            "zset" => Self::empty_structure(
                "REDIS SORTED SET",
                vec![
                    Self::detail("member", "TEXT", Some("Sorted set member")),
                    Self::detail("score", "DOUBLE", Some("Sorted set score")),
                ],
            ),
            "stream" => Self::empty_structure(
                "REDIS STREAM",
                vec![
                    Self::detail("id", "TEXT", Some("Stream entry id")),
                    Self::detail("payload", "JSON", Some("Stream entry fields")),
                ],
            ),
            _ => Self::empty_structure(
                "REDIS KEY",
                vec![
                    Self::detail("key", "TEXT", Some("Redis key name")),
                    Self::detail("value", "TEXT", Some("Redis value projection")),
                ],
            ),
        }
    }

    fn maybe_filter_rows(rows: Vec<Vec<JsonValue>>, filter: Option<&str>) -> Vec<Vec<JsonValue>> {
        let Some(needle) = filter.map(str::trim).filter(|value| !value.is_empty()) else {
            return rows;
        };
        let needle = needle.to_ascii_lowercase();

        rows.into_iter()
            .filter(|row| {
                row.iter().any(|cell| {
                    let haystack = match cell {
                        JsonValue::Null => String::new(),
                        JsonValue::String(value) => value.clone(),
                        other => other.to_string(),
                    };
                    haystack.to_ascii_lowercase().contains(&needle)
                })
            })
            .collect::<Vec<_>>()
    }

    fn fetch_hash_rows(connection: &mut RedisConnection, table: &str) -> Result<Vec<Vec<JsonValue>>> {
        let value = cmd("HGETALL")
            .arg(table)
            .query::<RedisValue>(connection)
            .with_context(|| format!("Failed to fetch Redis hash rows for {table}"))?;

        Ok(Self::rows_from_pair_array(value, "field", "value")
            .map(|(_, rows)| rows)
            .unwrap_or_default())
    }

    fn fetch_list_rows(connection: &mut RedisConnection, table: &str) -> Result<Vec<Vec<JsonValue>>> {
        let values = cmd("LRANGE")
            .arg(table)
            .arg(0)
            .arg(-1)
            .query::<Vec<Vec<u8>>>(connection)
            .with_context(|| format!("Failed to fetch Redis list rows for {table}"))?;

        Ok(values
            .into_iter()
            .enumerate()
            .map(|(index, value)| vec![JsonValue::from(index as i64), JsonValue::String(Self::bytes_to_string(&value))])
            .collect::<Vec<_>>())
    }

    fn fetch_set_rows(connection: &mut RedisConnection, table: &str) -> Result<Vec<Vec<JsonValue>>> {
        let mut members = cmd("SMEMBERS")
            .arg(table)
            .query::<Vec<Vec<u8>>>(connection)
            .with_context(|| format!("Failed to fetch Redis set rows for {table}"))?;
        members.sort();

        Ok(members
            .into_iter()
            .map(|member| vec![JsonValue::String(Self::bytes_to_string(&member))])
            .collect::<Vec<_>>())
    }

    fn fetch_zset_rows(connection: &mut RedisConnection, table: &str) -> Result<Vec<Vec<JsonValue>>> {
        let value = cmd("ZRANGE")
            .arg(table)
            .arg(0)
            .arg(-1)
            .arg("WITHSCORES")
            .query::<RedisValue>(connection)
            .with_context(|| format!("Failed to fetch Redis sorted-set rows for {table}"))?;

        Ok(Self::rows_from_pair_array(value, "member", "score")
            .map(|(_, rows)| rows)
            .unwrap_or_default())
    }

    fn fetch_stream_rows(connection: &mut RedisConnection, table: &str) -> Result<Vec<Vec<JsonValue>>> {
        let value = cmd("XRANGE")
            .arg(table)
            .arg("-")
            .arg("+")
            .query::<RedisValue>(connection)
            .with_context(|| format!("Failed to fetch Redis stream rows for {table}"))?;

        let rows = match value {
            RedisValue::Array(entries) => entries
                .into_iter()
                .filter_map(|entry| match entry {
                    RedisValue::Array(mut parts) if parts.len() == 2 => {
                        let id = Self::redis_value_to_cell(parts.remove(0));
                        let payload = JsonValue::String(Self::redis_value_to_json(parts.remove(0)).to_string());
                        Some(vec![id, payload])
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };

        Ok(rows)
    }
}

#[async_trait]
impl DatabaseDriver for RedisDriver {
    async fn ping(&self) -> Result<()> {
        self.with_connection(|connection, _| {
            let _: String = cmd("PING")
                .query(connection)
                .context("Redis ping failed")?;
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
            let info_result = cmd("INFO")
                .arg("keyspace")
                .query::<String>(connection);

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

            if !databases.iter().any(|database| database.name == current_label) {
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
                        .with_context(|| format!("Failed to fetch Redis string value for {}", table_name))?;
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
                    vec![Self::column("index", "INTEGER"), Self::column("value", "TEXT")],
                    Self::fetch_list_rows(connection, &table_name)?,
                ),
                "set" => (
                    vec![Self::column("member", "TEXT")],
                    Self::fetch_set_rows(connection, &table_name)?,
                ),
                "zset" => (
                    vec![Self::column("member", "TEXT"), Self::column("score", "DOUBLE")],
                    Self::fetch_zset_rows(connection, &table_name)?,
                ),
                "stream" => (
                    vec![Self::column("id", "TEXT"), Self::column("payload", "JSON")],
                    Self::fetch_stream_rows(connection, &table_name)?,
                ),
                _ => {
                    (
                        vec![Self::column("key", "TEXT"), Self::column("value", "TEXT")],
                        vec![vec![
                            JsonValue::String(table_name.clone()),
                            JsonValue::String(format!("Unsupported Redis key type: {key_type}")),
                        ]],
                    )
                }
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
                    .with_context(|| format!("Failed to count Redis hash entries for {}", table_name))?,
                "list" => cmd("LLEN")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| format!("Failed to count Redis list entries for {}", table_name))?,
                "set" => cmd("SCARD")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| format!("Failed to count Redis set members for {}", table_name))?,
                "zset" => cmd("ZCARD")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| format!("Failed to count Redis sorted-set members for {}", table_name))?,
                "stream" => cmd("XLEN")
                    .arg(&table_name)
                    .query::<i64>(connection)
                    .with_context(|| format!("Failed to count Redis stream entries for {}", table_name))?,
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
        let commands = RedisDriver::parse_command_lines("SET greeting \"hello world\"\nPING").unwrap();
        assert_eq!(
            commands,
            vec![
                vec!["SET".to_string(), "greeting".to_string(), "hello world".to_string()],
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
