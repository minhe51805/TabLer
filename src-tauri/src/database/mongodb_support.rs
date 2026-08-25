use super::models::*;
use super::mongodb::{MongoDbDriver, MongoQueryCommand, MongoUpdatePayload};
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Result};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use mongodb::{Collection, IndexModel};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet};

/// BSON/JSON conversion, MQL command parsing, and projection helpers for the
/// MongoDB driver, split into a second inherent impl block.
impl MongoDbDriver {
    pub(super) fn parse_relaxed_json_value(input: &str) -> Result<JsonValue> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Expected JSON input"));
        }

        serde_json::from_str::<JsonValue>(trimmed)
            .or_else(|_| json5::from_str::<JsonValue>(trimmed))
            .map_err(|error| anyhow!("Expected valid JSON/JSON5 input: {error}"))
    }

    pub(super) fn json_value_to_bson(value: JsonValue) -> Result<Bson> {
        Ok(match value {
            JsonValue::Null => Bson::Null,
            JsonValue::Bool(value) => Bson::Boolean(value),
            JsonValue::Number(value) => {
                if let Some(int_value) = value.as_i64() {
                    Bson::Int64(int_value)
                } else if let Some(float_value) = value.as_f64() {
                    Bson::Double(float_value)
                } else {
                    return Err(anyhow!("Unsupported numeric value"));
                }
            }
            JsonValue::String(value) => {
                if value.len() == 24
                    && value.chars().all(|ch| ch.is_ascii_hexdigit())
                    && ObjectId::parse_str(&value).is_ok()
                {
                    Bson::ObjectId(ObjectId::parse_str(&value)?)
                } else {
                    Bson::String(value)
                }
            }
            JsonValue::Array(values) => Bson::Array(
                values
                    .into_iter()
                    .map(Self::json_value_to_bson)
                    .collect::<Result<Vec<_>>>()?,
            ),
            JsonValue::Object(values) => {
                let mut document = Document::new();
                for (key, value) in values {
                    document.insert(key, Self::json_value_to_bson(value)?);
                }
                Bson::Document(document)
            }
        })
    }

    pub(super) fn json_value_to_document(value: JsonValue) -> Result<Document> {
        match Self::json_value_to_bson(value)? {
            Bson::Document(document) => Ok(document),
            _ => Err(anyhow!("Expected a JSON object")),
        }
    }

    pub(super) fn json_value_to_document_array(value: JsonValue) -> Result<Vec<Document>> {
        match value {
            JsonValue::Array(items) => items
                .into_iter()
                .map(Self::json_value_to_document)
                .collect::<Result<Vec<_>>>(),
            _ => Err(anyhow!("Expected a JSON array of objects")),
        }
    }

    pub(super) fn bson_to_json(value: Bson) -> JsonValue {
        match value {
            Bson::Double(value) => JsonValue::from(value),
            Bson::String(value) => JsonValue::String(value),
            Bson::Array(values) => JsonValue::Array(
                values
                    .into_iter()
                    .map(Self::bson_to_json)
                    .collect::<Vec<_>>(),
            ),
            Bson::Document(document) => JsonValue::Object(
                document
                    .into_iter()
                    .map(|(key, value)| (key, Self::bson_to_json(value)))
                    .collect::<JsonMap<String, JsonValue>>(),
            ),
            Bson::Boolean(value) => JsonValue::Bool(value),
            Bson::Null => JsonValue::Null,
            Bson::Int32(value) => JsonValue::from(value),
            Bson::Int64(value) => JsonValue::from(value),
            Bson::Timestamp(value) => {
                JsonValue::String(format!("{}:{}", value.time, value.increment))
            }
            Bson::Binary(value) => JsonValue::String(format!(
                "0x{}",
                value
                    .bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )),
            Bson::ObjectId(value) => JsonValue::String(value.to_hex()),
            Bson::DateTime(value) => JsonValue::String(value.to_string()),
            Bson::RegularExpression(value) => {
                JsonValue::String(format!("/{}/{}", value.pattern, value.options))
            }
            Bson::Decimal128(value) => JsonValue::String(value.to_string()),
            Bson::JavaScriptCode(value) => JsonValue::String(value),
            Bson::JavaScriptCodeWithScope(value) => JsonValue::Object(
                [
                    ("code".to_string(), JsonValue::String(value.code)),
                    (
                        "scope".to_string(),
                        Self::bson_to_json(Bson::Document(value.scope)),
                    ),
                ]
                .into_iter()
                .collect(),
            ),
            Bson::Symbol(value) => JsonValue::String(value),
            Bson::Undefined => JsonValue::String("undefined".to_string()),
            Bson::MaxKey => JsonValue::String("MaxKey".to_string()),
            Bson::MinKey => JsonValue::String("MinKey".to_string()),
            Bson::DbPointer(value) => JsonValue::String(format!("{value:?}")),
        }
    }

    pub(super) fn bson_to_grid_cell(value: Bson) -> JsonValue {
        match value {
            Bson::Document(_) | Bson::Array(_) => {
                JsonValue::String(Self::bson_to_json(value).to_string())
            }
            other => Self::bson_to_json(other),
        }
    }

    pub(super) fn bson_type_name(value: &Bson) -> &'static str {
        match value {
            Bson::Double(_) => "double",
            Bson::String(_) => "string",
            Bson::Array(_) => "array",
            Bson::Document(_) => "object",
            Bson::Boolean(_) => "bool",
            Bson::Null => "null",
            Bson::Int32(_) => "int32",
            Bson::Int64(_) => "int64",
            Bson::Timestamp(_) => "timestamp",
            Bson::Binary(_) => "binary",
            Bson::ObjectId(_) => "objectId",
            Bson::DateTime(_) => "date",
            Bson::RegularExpression(_) => "regex",
            Bson::Decimal128(_) => "decimal128",
            Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
            Bson::Symbol(_) => "symbol",
            Bson::Undefined => "undefined",
            Bson::MaxKey => "maxKey",
            Bson::MinKey => "minKey",
            Bson::DbPointer(_) => "dbPointer",
        }
    }

    pub(super) fn infer_columns_from_documents(documents: &[Document]) -> Vec<ColumnInfo> {
        let mut ordered_names = Vec::new();
        let mut seen_names = BTreeSet::new();
        let mut type_map = BTreeMap::<String, String>::new();

        for document in documents {
            for (key, value) in document {
                if seen_names.insert(key.clone()) {
                    ordered_names.push(key.clone());
                }
                if !type_map.contains_key(key) && !matches!(value, Bson::Null) {
                    type_map.insert(key.clone(), Self::bson_type_name(value).to_string());
                }
            }
        }

        ordered_names
            .into_iter()
            .map(|name| ColumnInfo {
                name: name.clone(),
                data_type: type_map
                    .get(&name)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                is_nullable: true,
                is_primary_key: name == "_id",
                max_length: None,
                default_value: None,
            })
            .collect()
    }

    pub(super) fn documents_to_rows(
        documents: &[Document],
        columns: &[ColumnInfo],
    ) -> Vec<Vec<JsonValue>> {
        documents
            .iter()
            .map(|document| {
                columns
                    .iter()
                    .map(|column| {
                        document
                            .get(&column.name)
                            .cloned()
                            .map(Self::bson_to_grid_cell)
                            .unwrap_or(JsonValue::Null)
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub(super) fn documents_to_result(
        documents: Vec<Document>,
        elapsed: u128,
        query: String,
        affected_rows: u64,
        truncated: bool,
    ) -> QueryResult {
        let columns = Self::infer_columns_from_documents(&documents);
        let rows = Self::documents_to_rows(&documents, &columns);
        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed: false,
            truncated,
        }
    }

    pub(super) fn scalar_result(
        label: &str,
        value: JsonValue,
        elapsed: u128,
        query: String,
        affected_rows: u64,
    ) -> QueryResult {
        QueryResult {
            columns: vec![ColumnInfo {
                name: label.to_string(),
                data_type: match value {
                    JsonValue::Bool(_) => "bool".to_string(),
                    JsonValue::Number(_) => "number".to_string(),
                    JsonValue::String(_) => "string".to_string(),
                    JsonValue::Null => "null".to_string(),
                    JsonValue::Array(_) => "array".to_string(),
                    JsonValue::Object(_) => "object".to_string(),
                },
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            }],
            rows: vec![vec![value]],
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed: false,
            truncated: false,
        }
    }

    pub(super) async fn collect_cursor_limited(
        mut cursor: mongodb::Cursor<Document>,
    ) -> Result<(Vec<Document>, bool)> {
        let mut documents = Vec::new();
        while let Some(document) = cursor.try_next().await? {
            if documents.len() == MAX_QUERY_RESULT_ROWS {
                return Ok((documents, true));
            }
            documents.push(document);
        }
        Ok((documents, false))
    }

    pub(super) fn parse_json_document_arg(input: &str) -> Result<Document> {
        Self::json_value_to_document(Self::parse_relaxed_json_value(input)?)
    }

    pub(super) fn parse_json_document_array_arg(input: &str) -> Result<Vec<Document>> {
        Self::json_value_to_document_array(Self::parse_relaxed_json_value(input)?)
    }

    pub(super) fn parse_filter_document(filter: Option<&str>) -> Result<Document> {
        match filter.map(str::trim).filter(|value| !value.is_empty()) {
            None => Ok(Document::new()),
            Some(raw_filter) if raw_filter.starts_with('{') => {
                Self::parse_json_document_arg(raw_filter)
            }
            Some(_) => Err(anyhow!(
                "MongoDB table filters must be JSON documents, for example {{\"status\":\"active\"}}"
            )),
        }
    }

    pub(super) fn build_sort_document(
        order_by: Option<&str>,
        order_dir: Option<&str>,
    ) -> Option<Document> {
        let field = order_by.map(str::trim).filter(|value| !value.is_empty())?;
        let direction = match order_dir
            .unwrap_or("ASC")
            .trim()
            .to_ascii_uppercase()
            .as_str()
        {
            "DESC" => -1,
            _ => 1,
        };
        let mut sort = Document::new();
        sort.insert(field.to_string(), Bson::Int32(direction));
        Some(sort)
    }

    pub(super) fn insert_type_hint(
        fields: &mut BTreeMap<String, (String, bool)>,
        path: String,
        value: &Bson,
    ) {
        if path.is_empty() {
            return;
        }

        let type_name = Self::bson_type_name(value).to_string();
        fields
            .entry(path.clone())
            .or_insert_with(|| (type_name.clone(), path == "_id"));

        if let Bson::Document(document) = value {
            for (child_key, child_value) in document {
                Self::insert_type_hint(fields, format!("{path}.{child_key}"), child_value);
            }
        }
    }

    pub(super) async fn infer_structure(
        &self,
        collection: &Collection<Document>,
    ) -> Result<Vec<ColumnDetail>> {
        let cursor = collection.find(doc! {}).limit(50).await?;
        let (documents, _) = Self::collect_cursor_limited(cursor).await?;
        let mut fields = BTreeMap::<String, (String, bool)>::new();

        for document in &documents {
            for (key, value) in document {
                Self::insert_type_hint(&mut fields, key.clone(), value);
            }
        }

        Ok(fields
            .into_iter()
            .map(|(name, (data_type, is_primary_key))| ColumnDetail {
                name,
                data_type: data_type.clone(),
                is_nullable: true,
                is_primary_key,
                default_value: None,
                extra: None,
                column_type: Some(data_type),
                comment: None,
            })
            .collect())
    }

    pub(super) async fn infer_indexes(
        &self,
        collection: &Collection<Document>,
    ) -> Result<Vec<IndexInfo>> {
        let mut cursor = collection.list_indexes().await?;
        let mut indexes = Vec::new();
        while let Some(index) = cursor.try_next().await? {
            indexes.push(Self::index_model_to_info(index));
        }
        Ok(indexes)
    }

    pub(super) fn index_model_to_info(index: IndexModel) -> IndexInfo {
        let columns = index.keys.keys().cloned().collect::<Vec<_>>();
        let name = index
            .options
            .as_ref()
            .and_then(|options| options.name.clone())
            .unwrap_or_else(|| columns.join("_"));
        let is_unique = index
            .options
            .as_ref()
            .and_then(|options| options.unique)
            .unwrap_or(false);
        IndexInfo {
            name,
            columns,
            is_unique,
            index_type: Some("mongodb".to_string()),
        }
    }

    pub(super) fn parse_object_id_from_json_value(value: &JsonValue) -> Option<ObjectId> {
        let string_value = value.as_str()?;
        if string_value.len() == 24 && string_value.chars().all(|ch| ch.is_ascii_hexdigit()) {
            ObjectId::parse_str(string_value).ok()
        } else {
            None
        }
    }

    pub(super) fn row_selector_to_filter(primary_keys: &[RowKeyValue]) -> Result<Document> {
        if primary_keys.is_empty() {
            return Err(anyhow!(
                "MongoDB row operations require at least one key field, usually _id"
            ));
        }

        let mut filter = Document::new();
        for key in primary_keys {
            let bson_value = if key.column == "_id" {
                if let Some(object_id) = Self::parse_object_id_from_json_value(&key.value) {
                    Bson::ObjectId(object_id)
                } else {
                    Self::json_value_to_bson(key.value.clone())?
                }
            } else {
                Self::json_value_to_bson(key.value.clone())?
            };
            filter.insert(key.column.clone(), bson_value);
        }
        Ok(filter)
    }

    pub(super) fn strip_optional_semicolon(value: &str) -> &str {
        value.trim().trim_end_matches(';').trim()
    }

    pub(super) fn find_matching_closer(input: &str, open: char, close: char) -> Result<usize> {
        let mut depth = 1usize;
        let mut active_quote = None::<char>;
        let mut escaped = false;

        for (index, ch) in input.char_indices() {
            if let Some(quote) = active_quote {
                if escaped {
                    escaped = false;
                    continue;
                }
                if ch == '\\' {
                    escaped = true;
                    continue;
                }
                if ch == quote {
                    active_quote = None;
                }
                continue;
            }

            match ch {
                '\'' | '"' => active_quote = Some(ch),
                c if c == open => depth += 1,
                c if c == close => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(index);
                    }
                }
                _ => {}
            }
        }

        Err(anyhow!("Unbalanced delimiter in MongoDB command"))
    }

    pub(super) fn split_top_level_args(input: &str) -> Result<Vec<String>> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let mut parts = Vec::new();
        let mut start = 0usize;
        let mut brace_depth = 0usize;
        let mut bracket_depth = 0usize;
        let mut paren_depth = 0usize;
        let mut active_quote = None::<char>;
        let mut escaped = false;

        for (index, ch) in trimmed.char_indices() {
            if let Some(quote) = active_quote {
                if escaped {
                    escaped = false;
                    continue;
                }
                if ch == '\\' {
                    escaped = true;
                    continue;
                }
                if ch == quote {
                    active_quote = None;
                }
                continue;
            }

            match ch {
                '\'' | '"' => active_quote = Some(ch),
                '{' => brace_depth += 1,
                '}' => brace_depth = brace_depth.saturating_sub(1),
                '[' => bracket_depth += 1,
                ']' => bracket_depth = bracket_depth.saturating_sub(1),
                '(' => paren_depth += 1,
                ')' => paren_depth = paren_depth.saturating_sub(1),
                ',' if brace_depth == 0 && bracket_depth == 0 && paren_depth == 0 => {
                    parts.push(trimmed[start..index].trim().to_string());
                    start = index + ch.len_utf8();
                }
                _ => {}
            }
        }

        parts.push(trimmed[start..].trim().to_string());
        Ok(parts.into_iter().filter(|part| !part.is_empty()).collect())
    }

    pub(super) fn parse_collection_call(input: &str) -> Result<(String, String, String)> {
        let trimmed = Self::strip_optional_semicolon(input);
        let after_db = trimmed
            .strip_prefix("db.")
            .ok_or_else(|| anyhow!("MongoDB commands must start with db."))?;

        let (collection, after_collection) =
            if let Some(after_get_collection) = after_db.strip_prefix("getCollection(") {
                let close_index = Self::find_matching_closer(after_get_collection, '(', ')')?;
                let raw_collection = after_get_collection[..close_index].trim();
                let collection_value = Self::parse_relaxed_json_value(raw_collection)?;
                let collection = collection_value.as_str().ok_or_else(|| {
                    anyhow!("db.getCollection(...) requires a string collection name")
                })?;
                let remainder = after_get_collection[close_index + 1..].trim();
                (collection.to_string(), remainder)
            } else {
                let dot_index = after_db.find('.').ok_or_else(|| {
                    anyhow!("MongoDB collection command is missing a method name")
                })?;
                (
                    after_db[..dot_index].trim().to_string(),
                    after_db[dot_index..].trim(),
                )
            };

        if collection.is_empty() {
            return Err(anyhow!("MongoDB collection name cannot be empty"));
        }

        let after_dot = after_collection
            .strip_prefix('.')
            .ok_or_else(|| anyhow!("MongoDB collection command is missing a method separator"))?;
        let open_index = after_dot
            .find('(')
            .ok_or_else(|| anyhow!("MongoDB collection command is missing parentheses"))?;
        let method = after_dot[..open_index].trim().to_string();
        let inside = &after_dot[open_index + 1..];
        let close_index = Self::find_matching_closer(inside, '(', ')')?;
        let args = inside[..close_index].trim().to_string();
        let trailing = inside[close_index + 1..].trim();
        if !trailing.is_empty() {
            return Err(anyhow!(
                "Unexpected trailing characters after MongoDB command"
            ));
        }

        Ok((collection, method, args))
    }

    pub(super) fn parse_update_payload(input: &str) -> Result<MongoUpdatePayload> {
        let value = Self::parse_relaxed_json_value(input)?;
        if matches!(value, JsonValue::Array(_)) {
            Ok(MongoUpdatePayload::Pipeline(
                Self::json_value_to_document_array(value)?,
            ))
        } else {
            Ok(MongoUpdatePayload::Document(Self::json_value_to_document(
                value,
            )?))
        }
    }

    pub(super) fn parse_command(input: &str) -> Result<MongoQueryCommand> {
        let trimmed = Self::strip_optional_semicolon(input);
        if trimmed.is_empty() {
            return Err(anyhow!("MongoDB command cannot be empty"));
        }

        if trimmed.starts_with('{') {
            return Ok(MongoQueryCommand::RunCommand(
                Self::parse_json_document_arg(trimmed)?,
            ));
        }

        if let Some(after_run_command) = trimmed.strip_prefix("db.runCommand(") {
            let close_index = Self::find_matching_closer(after_run_command, '(', ')')?;
            let command = Self::parse_json_document_arg(after_run_command[..close_index].trim())?;
            let trailing = after_run_command[close_index + 1..].trim();
            if !trailing.is_empty() {
                return Err(anyhow!(
                    "Unexpected trailing characters after db.runCommand(...)"
                ));
            }
            return Ok(MongoQueryCommand::RunCommand(command));
        }

        let (collection, method, args) = Self::parse_collection_call(trimmed)?;
        let split_args = Self::split_top_level_args(&args)?;

        match method.to_ascii_lowercase().as_str() {
            "find" => Ok(MongoQueryCommand::Find {
                collection,
                filter: match split_args.first() {
                    Some(value) => Self::parse_json_document_arg(value)?,
                    None => Document::new(),
                },
            }),
            "findone" => Ok(MongoQueryCommand::FindOne {
                collection,
                filter: match split_args.first() {
                    Some(value) => Self::parse_json_document_arg(value)?,
                    None => Document::new(),
                },
            }),
            "aggregate" => Ok(MongoQueryCommand::Aggregate {
                collection,
                pipeline: match split_args.first() {
                    Some(value) => Self::parse_json_document_array_arg(value)?,
                    None => Vec::new(),
                },
            }),
            "countdocuments" => Ok(MongoQueryCommand::CountDocuments {
                collection,
                filter: match split_args.first() {
                    Some(value) => Self::parse_json_document_arg(value)?,
                    None => Document::new(),
                },
            }),
            "insertone" => Ok(MongoQueryCommand::InsertOne {
                collection,
                document: Self::parse_json_document_arg(
                    split_args
                        .first()
                        .ok_or_else(|| anyhow!("insertOne requires one document argument"))?,
                )?,
            }),
            "insertmany" => Ok(MongoQueryCommand::InsertMany {
                collection,
                documents: Self::parse_json_document_array_arg(
                    split_args
                        .first()
                        .ok_or_else(|| anyhow!("insertMany requires an array of documents"))?,
                )?,
            }),
            "updateone" => Ok(MongoQueryCommand::UpdateOne {
                collection,
                filter: Self::parse_json_document_arg(
                    split_args
                        .first()
                        .ok_or_else(|| anyhow!("updateOne requires a filter document"))?,
                )?,
                update: Self::parse_update_payload(
                    split_args
                        .get(1)
                        .ok_or_else(|| anyhow!("updateOne requires an update document"))?,
                )?,
            }),
            "updatemany" => Ok(MongoQueryCommand::UpdateMany {
                collection,
                filter: Self::parse_json_document_arg(
                    split_args
                        .first()
                        .ok_or_else(|| anyhow!("updateMany requires a filter document"))?,
                )?,
                update: Self::parse_update_payload(
                    split_args
                        .get(1)
                        .ok_or_else(|| anyhow!("updateMany requires an update document"))?,
                )?,
            }),
            "deleteone" => Ok(MongoQueryCommand::DeleteOne {
                collection,
                filter: match split_args.first() {
                    Some(value) => Self::parse_json_document_arg(value)?,
                    None => Document::new(),
                },
            }),
            "deletemany" => Ok(MongoQueryCommand::DeleteMany {
                collection,
                filter: match split_args.first() {
                    Some(value) => Self::parse_json_document_arg(value)?,
                    None => Document::new(),
                },
            }),
            _ => Err(anyhow!(
                "Unsupported MongoDB command. Supported helpers: db.runCommand(...), find/findOne, aggregate, countDocuments, insertOne/insertMany, updateOne/updateMany, deleteOne/deleteMany."
            )),
        }
    }
}
