use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use redis::{cmd, Connection as RedisConnection, Value as RedisValue};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::cmp::Ordering;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

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
        // The first projected column is the row identity (key/field/index/
        // member/id); flagging it as the primary key lets the grid build
        // selectors for inline edits and deletes.
        let mark_identity = |columns: Vec<ColumnDetail>| {
            let mut columns = columns;
            if let Some(first) = columns.first_mut() {
                first.is_primary_key = true;
            }
            columns
        };
        match key_type {
            "string" => Self::empty_structure(
                "REDIS STRING",
                mark_identity(vec![
                    Self::detail("key", "TEXT", Some("Redis key name")),
                    Self::detail("value", "TEXT", Some("String value")),
                ]),
            ),
            "hash" => Self::empty_structure(
                "REDIS HASH",
                mark_identity(vec![
                    Self::detail("field", "TEXT", Some("Hash field name")),
                    Self::detail("value", "TEXT", Some("Hash field value")),
                ]),
            ),
            "list" => Self::empty_structure(
                "REDIS LIST",
                mark_identity(vec![
                    Self::detail("index", "INTEGER", Some("List item index")),
                    Self::detail("value", "TEXT", Some("List item value")),
                ]),
            ),
            "set" => Self::empty_structure(
                "REDIS SET",
                mark_identity(vec![Self::detail("member", "TEXT", Some("Set member"))]),
            ),
            "zset" => Self::empty_structure(
                "REDIS SORTED SET",
                mark_identity(vec![
                    Self::detail("member", "TEXT", Some("Sorted set member")),
                    Self::detail("score", "DOUBLE", Some("Sorted set score")),
                ]),
            ),
            "stream" => Self::empty_structure(
                "REDIS STREAM",
                mark_identity(vec![
                    Self::detail("id", "TEXT", Some("Stream entry id")),
                    Self::detail("payload", "JSON", Some("Stream entry fields")),
                ]),
            ),
            _ => Self::empty_structure(
                "REDIS KEY",
                mark_identity(vec![
                    Self::detail("key", "TEXT", Some("Redis key name")),
                    Self::detail("value", "TEXT", Some("Redis value projection")),
                ]),
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

    // ------------------------------------------------------------------
    // Write-path command builders (pure — no connection access). The
    // driver queues the returned argv lists inside MULTI/EXEC so a batch
    // either applies completely or is DISCARDed.
    // ------------------------------------------------------------------

    /// Column that identifies one projected row for a key type. Mirrors the
    /// primary-key flag `build_structure_for_key_type` sets on the first
    /// column, so a selector built from the grid always matches.
    pub(super) fn identity_column_for_key_type(key_type: &str) -> Option<&'static str> {
        match key_type {
            "string" => Some("key"),
            "hash" => Some("field"),
            "list" => Some("index"),
            "set" | "zset" => Some("member"),
            "stream" => Some("id"),
            _ => None,
        }
    }

    /// Converts a grid cell into a Redis command argument. Redis stores
    /// bytes only: numbers/bools serialize, structured values keep their
    /// JSON text, and NULL is rejected rather than silently stringified.
    pub(super) fn json_cell_to_redis_arg(value: &JsonValue) -> Result<String> {
        match value {
            JsonValue::Null => Err(anyhow!("Redis values cannot be NULL")),
            JsonValue::String(text) => Ok(text.clone()),
            JsonValue::Number(number) => Ok(number.to_string()),
            JsonValue::Bool(flag) => Ok(flag.to_string()),
            other => Ok(other.to_string()),
        }
    }

    /// The single primary-key selector for a request, validated to name the
    /// identity column of the key type.
    fn row_selector<'a>(
        primary_keys: &'a [RowKeyValue],
        key_type: &str,
        table: &str,
    ) -> Result<&'a JsonValue> {
        let identity = Self::identity_column_for_key_type(key_type)
            .ok_or_else(|| anyhow!("Redis key type '{key_type}' has no editable row identity"))?;
        if primary_keys.len() != 1 {
            return Err(anyhow!(
                "Redis {key_type} rows are identified by exactly one '{identity}' value"
            ));
        }
        let key = &primary_keys[0];
        if key.column != identity {
            return Err(anyhow!(
                "Redis {key_type} rows are identified by '{identity}', not '{}'",
                key.column
            ));
        }
        // String keys are the row identity themselves: the selector must
        // name the key being edited, not an arbitrary other key. List
        // indexes legitimately arrive as JSON numbers, so only string-key
        // selectors are string-checked here; per-type arms validate the
        // shape they need.
        if key_type == "string" {
            let selector = key.value.as_str().ok_or_else(|| {
                anyhow!("Redis {key_type} selector for '{identity}' must be a string")
            })?;
            if selector != table {
                return Err(anyhow!(
                    "Redis string selector '{selector}' does not match key '{table}'"
                ));
            }
        }
        Ok(&key.value)
    }

    fn redis_list_index(value: &JsonValue) -> Result<i64> {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
            .ok_or_else(|| anyhow!("Redis list index must be an integer"))
    }

    /// Commands for one cell update on a key of known type. Identity-column
    /// edits are rejected: renaming a member/field/id is a delete+insert,
    /// not an in-place update.
    pub(super) fn build_cell_update_commands_for_type(
        update: &TableCellUpdateRequest,
        key_type: &str,
    ) -> Result<Vec<Vec<String>>> {
        let table = update.table.trim();
        if table.is_empty() {
            return Err(anyhow!("Redis key name cannot be empty"));
        }
        if let Some(identity) = Self::identity_column_for_key_type(key_type) {
            if update.target_column == identity {
                return Err(anyhow!(
                    "Redis {key_type} '{identity}' values cannot be edited in place; delete and re-add the entry instead"
                ));
            }
        }
        let selector = Self::row_selector(&update.primary_keys, key_type, table)?;
        let value = Self::json_cell_to_redis_arg(&update.value)?;
        let commands = match key_type {
            "string" => {
                if update.target_column != "value" {
                    return Err(anyhow!(
                        "Redis string keys only expose a 'value' column, not '{}'",
                        update.target_column
                    ));
                }
                vec![vec!["SET".into(), table.into(), value]]
            }
            "hash" => {
                if update.target_column != "value" {
                    return Err(anyhow!(
                        "Redis hashes only expose a 'value' column, not '{}'",
                        update.target_column
                    ));
                }
                let field = selector
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis hash field selector must be a string"))?;
                vec![vec!["HSET".into(), table.into(), field.into(), value]]
            }
            "list" => {
                if update.target_column != "value" {
                    return Err(anyhow!(
                        "Redis lists only expose a 'value' column, not '{}'",
                        update.target_column
                    ));
                }
                let index = Self::redis_list_index(selector)?;
                vec![vec!["LSET".into(), table.into(), index.to_string(), value]]
            }
            "zset" => {
                if update.target_column != "score" {
                    return Err(anyhow!(
                        "Redis sorted sets only expose a 'score' column, not '{}'",
                        update.target_column
                    ));
                }
                let member = selector
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis sorted-set member selector must be a string"))?;
                vec![vec!["ZADD".into(), table.into(), value, member.into()]]
            }
            "stream" => {
                return Err(anyhow!(
                    "Redis stream entries are immutable; delete the entry and re-add it instead"
                ));
            }
            other => {
                return Err(anyhow!(
                    "Redis key type '{other}' does not support cell updates"
                ));
            }
        };
        Ok(commands)
    }

    /// Commands deleting one projected row of a key of known type. List rows
    /// delete by index through a unique sentinel (LSET + LREM) because Redis
    /// has no delete-by-index command.
    pub(super) fn build_row_delete_commands_for_type(
        table: &str,
        primary_keys: &[RowKeyValue],
        key_type: &str,
    ) -> Result<Vec<Vec<String>>> {
        let table = table.trim();
        if table.is_empty() {
            return Err(anyhow!("Redis key name cannot be empty"));
        }
        let selector = Self::row_selector(primary_keys, key_type, table)?;
        let commands = match key_type {
            "string" => vec![vec!["DEL".into(), table.into()]],
            "hash" => {
                let field = selector
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis hash field selector must be a string"))?;
                vec![vec!["HDEL".into(), table.into(), field.into()]]
            }
            "list" => {
                let index = Self::redis_list_index(selector)?;
                let sentinel = Self::list_delete_sentinel();
                vec![
                    vec![
                        "LSET".into(),
                        table.into(),
                        index.to_string(),
                        sentinel.clone(),
                    ],
                    vec!["LREM".into(), table.into(), "1".into(), sentinel],
                ]
            }
            "set" => {
                let member = selector
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis set member selector must be a string"))?;
                vec![vec!["SREM".into(), table.into(), member.into()]]
            }
            "zset" => {
                let member = selector
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis sorted-set member selector must be a string"))?;
                vec![vec!["ZREM".into(), table.into(), member.into()]]
            }
            "stream" => {
                let id = selector
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis stream id selector must be a string"))?;
                vec![vec!["XDEL".into(), table.into(), id.into()]]
            }
            other => {
                return Err(anyhow!(
                    "Redis key type '{other}' does not support row deletes"
                ));
            }
        };
        Ok(commands)
    }

    /// Commands inserting one row into a key of known type.
    pub(super) fn build_row_insert_commands_for_type(
        request: &TableRowInsertRequest,
        key_type: &str,
    ) -> Result<Vec<Vec<String>>> {
        let table = request.table.trim();
        if table.is_empty() {
            return Err(anyhow!("Redis key name cannot be empty"));
        }
        if request.values.is_empty() {
            return Err(anyhow!("Cannot insert an empty Redis row"));
        }
        let find = |name: &str| -> Option<&JsonValue> {
            request
                .values
                .iter()
                .find(|(column, _)| column == name)
                .map(|(_, value)| value)
        };
        let required = |name: &str| -> Result<&JsonValue> {
            find(name).ok_or_else(|| anyhow!("Redis {key_type} insert requires a '{name}' column"))
        };
        let commands = match key_type {
            "string" => {
                let value = Self::json_cell_to_redis_arg(required("value")?)?;
                vec![vec!["SET".into(), table.into(), value]]
            }
            "hash" => {
                let field = required("field")?
                    .as_str()
                    .ok_or_else(|| anyhow!("Redis hash field must be a string"))?;
                let value = Self::json_cell_to_redis_arg(required("value")?)?;
                vec![vec!["HSET".into(), table.into(), field.into(), value]]
            }
            "list" => {
                let value = Self::json_cell_to_redis_arg(required("value")?)?;
                vec![vec!["RPUSH".into(), table.into(), value]]
            }
            "set" => {
                let member = Self::json_cell_to_redis_arg(required("member")?)?;
                vec![vec!["SADD".into(), table.into(), member]]
            }
            "zset" => {
                let member = Self::json_cell_to_redis_arg(required("member")?)?;
                let score = Self::json_cell_to_redis_arg(required("score")?)?;
                vec![vec!["ZADD".into(), table.into(), score, member]]
            }
            "stream" => {
                let payload = required("payload")?;
                let id = find("id")
                    .and_then(JsonValue::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or("*");
                let fields = Self::stream_payload_fields(payload)?;
                if fields.is_empty() {
                    return Err(anyhow!(
                        "Redis stream insert requires a non-empty 'payload' object"
                    ));
                }
                let mut command = vec!["XADD".into(), table.into(), id.into()];
                for (field, value) in fields {
                    command.push(field);
                    command.push(value);
                }
                vec![command]
            }
            other => {
                return Err(anyhow!(
                    "Redis key type '{other}' does not support row inserts"
                ));
            }
        };
        Ok(commands)
    }

    /// Infers the key type an insert should create from the column names the
    /// grid/CSV mapping supplies. Returns None when the shape matches no
    /// projection so the caller can reject with a clear message.
    pub(super) fn infer_key_type_for_insert(
        request: &TableRowInsertRequest,
    ) -> Option<&'static str> {
        let has = |name: &str| request.values.iter().any(|(column, _)| column == name);
        if has("field") && has("value") {
            Some("hash")
        } else if has("member") && has("score") {
            Some("zset")
        } else if has("member") {
            Some("set")
        } else if has("payload") {
            Some("stream")
        } else if has("index") && has("value") {
            Some("list")
        } else if has("value") {
            Some("string")
        } else {
            None
        }
    }

    /// Flattens a stream payload cell into XADD field/value pairs. Accepts a
    /// JSON object or its stringified form (the grid stores payloads as
    /// JSON text).
    fn stream_payload_fields(payload: &JsonValue) -> Result<Vec<(String, String)>> {
        let parsed = match payload {
            JsonValue::Object(_) => payload.clone(),
            JsonValue::String(text) => serde_json::from_str::<JsonValue>(text)
                .with_context(|| "Redis stream payload must be a JSON object")?,
            _ => return Err(anyhow!("Redis stream payload must be a JSON object")),
        };
        let JsonValue::Object(map) = parsed else {
            return Err(anyhow!("Redis stream payload must be a JSON object"));
        };
        map.into_iter()
            .map(|(field, value)| Ok((field, Self::json_cell_to_redis_arg(&value)?)))
            .collect()
    }

    /// Unique sentinel for list delete-by-index (LSET index sentinel, then
    /// LREM 1 sentinel). Process-unique so it cannot collide with a real
    /// list element in practice.
    fn list_delete_sentinel() -> String {
        static SENTINEL_COUNTER: AtomicU64 = AtomicU64::new(0);
        let sequence = SENTINEL_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        format!(
            "__tabler_delete_{}_{}_{sequence}",
            std::process::id(),
            nanos
        )
    }

    /// Commands replaying one exported table entry from a TableR JSON
    /// snapshot: DEL clears any existing key so a type change cannot fail
    /// with WRONGTYPE, then the rows rebuild the value.
    pub(super) fn build_snapshot_table_commands(
        name: &str,
        object_type: Option<&str>,
        rows: &[JsonValue],
    ) -> Result<Vec<Vec<String>>> {
        let key_type = object_type
            .map(|raw| raw.trim().to_ascii_lowercase())
            .and_then(|raw| raw.strip_prefix("redis ").map(str::to_string).or(Some(raw)))
            .filter(|raw| !raw.is_empty())
            .or_else(|| Self::infer_key_type_from_snapshot_rows(rows));
        let Some(key_type) = key_type else {
            return Err(anyhow!(
                "Cannot determine the Redis key type for snapshot entry '{name}'"
            ));
        };
        let mut commands = vec![vec!["DEL".into(), name.to_string()]];
        for row in rows {
            let JsonValue::Object(map) = row else {
                return Err(anyhow!("Snapshot row for '{name}' is not a JSON object"));
            };
            let cell = |column: &str| -> Option<&JsonValue> { map.get(column) };
            let required = |column: &str| -> Result<&JsonValue> {
                cell(column).ok_or_else(|| {
                    anyhow!("Snapshot row for '{name}' is missing the '{column}' column")
                })
            };
            match key_type.as_str() {
                "string" => {
                    let value = Self::json_cell_to_redis_arg(required("value")?)?;
                    commands.push(vec!["SET".into(), name.to_string(), value]);
                }
                "hash" => {
                    let field = required("field")?.as_str().ok_or_else(|| {
                        anyhow!("Snapshot hash field for '{name}' must be a string")
                    })?;
                    let value = Self::json_cell_to_redis_arg(required("value")?)?;
                    commands.push(vec![
                        "HSET".into(),
                        name.to_string(),
                        field.to_string(),
                        value,
                    ]);
                }
                "list" => {
                    let value = Self::json_cell_to_redis_arg(required("value")?)?;
                    commands.push(vec!["RPUSH".into(), name.to_string(), value]);
                }
                "set" => {
                    let member = Self::json_cell_to_redis_arg(required("member")?)?;
                    commands.push(vec!["SADD".into(), name.to_string(), member]);
                }
                "zset" => {
                    let member = Self::json_cell_to_redis_arg(required("member")?)?;
                    let score = Self::json_cell_to_redis_arg(required("score")?)?;
                    commands.push(vec!["ZADD".into(), name.to_string(), score, member]);
                }
                "stream" => {
                    let payload = required("payload")?;
                    let fields = Self::stream_payload_fields(payload)?;
                    if fields.is_empty() {
                        continue;
                    }
                    let id = cell("id")
                        .and_then(JsonValue::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .unwrap_or("*");
                    let mut command = vec!["XADD".into(), name.to_string(), id.to_string()];
                    for (field, value) in fields {
                        command.push(field);
                        command.push(value);
                    }
                    commands.push(command);
                }
                other => {
                    return Err(anyhow!(
                        "Snapshot entry '{name}' has unsupported Redis key type '{other}'"
                    ));
                }
            }
        }
        Ok(commands)
    }

    /// Fallback key-type inference for snapshot entries whose structure was
    /// not exported: classify by the column names present in the first row.
    fn infer_key_type_from_snapshot_rows(rows: &[JsonValue]) -> Option<String> {
        let first = rows.iter().find_map(|row| row.as_object())?;
        let has = |name: &str| first.contains_key(name);
        if has("field") && has("value") {
            Some("hash".to_string())
        } else if has("member") && has("score") {
            Some("zset".to_string())
        } else if has("member") {
            Some("set".to_string())
        } else if has("payload") {
            Some("stream".to_string())
        } else if has("index") && has("value") {
            Some("list".to_string())
        } else if has("value") {
            Some("string".to_string())
        } else {
            None
        }
    }
}
