use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use redis::{cmd, Connection as RedisConnection, Value as RedisValue};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::cmp::Ordering;

use super::redis::RedisDriver;

const REDIS_SCAN_BATCH_SIZE: usize = 250;
const REDIS_MAX_DISCOVERED_KEYS: usize = 1000;

/// Pure projection helpers for the Redis driver. They never touch the
/// connection, so they live in a second inherent impl block here.
impl RedisDriver {
    pub(super) fn bytes_to_string(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).to_string()
    }

    pub(super) fn redis_value_to_json(value: RedisValue) -> JsonValue {
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

    pub(super) fn json_to_grid_cell(value: JsonValue) -> JsonValue {
        match value {
            JsonValue::Array(_) | JsonValue::Object(_) => JsonValue::String(value.to_string()),
            other => other,
        }
    }

    pub(super) fn redis_value_to_cell(value: RedisValue) -> JsonValue {
        Self::json_to_grid_cell(Self::redis_value_to_json(value))
    }

    pub(super) fn column(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            is_primary_key: false,
            max_length: None,
            default_value: None,
        }
    }

    pub(super) fn detail(name: &str, data_type: &str, extra: Option<&str>) -> ColumnDetail {
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

    pub(super) fn empty_structure(object_type: &str, columns: Vec<ColumnDetail>) -> TableStructure {
        TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some(object_type.to_string()),
        }
    }

    pub(super) fn compare_cells(left: &JsonValue, right: &JsonValue) -> Ordering {
        match (left.as_f64(), right.as_f64()) {
            (Some(left_number), Some(right_number)) => left_number
                .partial_cmp(&right_number)
                .unwrap_or(Ordering::Equal),
            _ => left.to_string().cmp(&right.to_string()),
        }
    }

    pub(super) fn sort_rows(
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

    pub(super) fn apply_offset_and_limit(
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

    pub(super) fn build_query_result(
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

    pub(super) fn rows_from_pair_array(
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
            rows.push(vec![
                Self::redis_value_to_cell(left),
                Self::redis_value_to_cell(right),
            ]);
        }

        Some((
            vec![
                Self::column(left_name, "TEXT"),
                Self::column(right_name, "TEXT"),
            ],
            rows,
        ))
    }

    pub(super) fn build_generic_query_table(
        value: RedisValue,
    ) -> (Vec<ColumnInfo>, Vec<Vec<JsonValue>>) {
        let json = Self::redis_value_to_json(value);

        match json {
            JsonValue::Array(items) => {
                if items
                    .iter()
                    .all(|item| matches!(item, JsonValue::Object(_)))
                {
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

    pub(super) fn build_command_query_result(
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
            "ZRANGE" | "ZREVRANGE"
                if command_tokens
                    .iter()
                    .any(|token| token.eq_ignore_ascii_case("WITHSCORES")) =>
            {
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
                        vec![
                            Self::column("cursor", "TEXT"),
                            Self::column("value", "TEXT"),
                        ],
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
                            vec![
                                Self::column("cursor", "TEXT"),
                                Self::column("value", "TEXT"),
                            ],
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
                                    JsonValue::String(
                                        Self::redis_value_to_json(payload).to_string(),
                                    ),
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

    pub(super) fn affected_rows_for_command(command_name: &str, value: &RedisValue) -> u64 {
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

    pub(super) fn parse_command_lines(script: &str) -> Result<Vec<Vec<String>>> {
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

    pub(super) fn key_type(connection: &mut RedisConnection, table: &str) -> Result<String> {
        let key_type = cmd("TYPE")
            .arg(table)
            .query::<String>(connection)
            .with_context(|| format!("Failed to inspect Redis key type for {table}"))?;
        Ok(key_type.to_ascii_lowercase())
    }

    pub(super) fn scan_keys(connection: &mut RedisConnection) -> Result<Vec<String>> {
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

    pub(super) fn build_structure_for_key_type(key_type: &str) -> TableStructure {
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

    pub(super) fn maybe_filter_rows(
        rows: Vec<Vec<JsonValue>>,
        filter: Option<&str>,
    ) -> Vec<Vec<JsonValue>> {
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

    pub(super) fn fetch_hash_rows(
        connection: &mut RedisConnection,
        table: &str,
    ) -> Result<Vec<Vec<JsonValue>>> {
        let value = cmd("HGETALL")
            .arg(table)
            .query::<RedisValue>(connection)
            .with_context(|| format!("Failed to fetch Redis hash rows for {table}"))?;

        Ok(Self::rows_from_pair_array(value, "field", "value")
            .map(|(_, rows)| rows)
            .unwrap_or_default())
    }

    pub(super) fn fetch_list_rows(
        connection: &mut RedisConnection,
        table: &str,
    ) -> Result<Vec<Vec<JsonValue>>> {
        let values = cmd("LRANGE")
            .arg(table)
            .arg(0)
            .arg(-1)
            .query::<Vec<Vec<u8>>>(connection)
            .with_context(|| format!("Failed to fetch Redis list rows for {table}"))?;

        Ok(values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                vec![
                    JsonValue::from(index as i64),
                    JsonValue::String(Self::bytes_to_string(&value)),
                ]
            })
            .collect::<Vec<_>>())
    }

    pub(super) fn fetch_set_rows(
        connection: &mut RedisConnection,
        table: &str,
    ) -> Result<Vec<Vec<JsonValue>>> {
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

    pub(super) fn fetch_zset_rows(
        connection: &mut RedisConnection,
        table: &str,
    ) -> Result<Vec<Vec<JsonValue>>> {
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

    pub(super) fn fetch_stream_rows(
        connection: &mut RedisConnection,
        table: &str,
    ) -> Result<Vec<Vec<JsonValue>>> {
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
                        let payload = JsonValue::String(
                            Self::redis_value_to_json(parts.remove(0)).to_string(),
                        );
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
