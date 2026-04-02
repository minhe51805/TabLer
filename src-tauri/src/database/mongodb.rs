use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database, IndexModel};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
use tokio::sync::RwLock;

pub struct MongoDbDriver {
    client: Client,
    current_db: RwLock<String>,
}

enum MongoQueryCommand {
    RunCommand(Document),
    Find {
        collection: String,
        filter: Document,
    },
    FindOne {
        collection: String,
        filter: Document,
    },
    Aggregate {
        collection: String,
        pipeline: Vec<Document>,
    },
    CountDocuments {
        collection: String,
        filter: Document,
    },
    InsertOne {
        collection: String,
        document: Document,
    },
    InsertMany {
        collection: String,
        documents: Vec<Document>,
    },
    UpdateOne {
        collection: String,
        filter: Document,
        update: MongoUpdatePayload,
    },
    UpdateMany {
        collection: String,
        filter: Document,
        update: MongoUpdatePayload,
    },
    DeleteOne {
        collection: String,
        filter: Document,
    },
    DeleteMany {
        collection: String,
        filter: Document,
    },
}

enum MongoUpdatePayload {
    Document(Document),
    Pipeline(Vec<Document>),
}

impl MongoDbDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let connection_uri = Self::build_connection_uri(config)?;
        let mut options = ClientOptions::parse(&connection_uri)
            .await
            .context("Failed to parse MongoDB connection options")?;
        options.app_name = Some("TableR".to_string());

        let client = Client::with_options(options).context("Failed to create MongoDB client")?;
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .context("MongoDB ping failed during connect")?;

        let current_db = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                config
                    .additional_fields
                    .get("auth_source")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "admin".to_string());

        Ok(Self {
            client,
            current_db: RwLock::new(current_db),
        })
    }

    fn build_connection_uri(config: &ConnectionConfig) -> Result<String> {
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("MongoDB host is required")?;

        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };

        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let password = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if username.is_none() && password.is_some() {
            return Err(anyhow!(
                "MongoDB password authentication requires a username"
            ));
        }

        let mut uri = String::from("mongodb://");
        if let Some(username) = username {
            uri.push_str(&Self::percent_encode(username));
            if let Some(password) = password {
                uri.push(':');
                uri.push_str(&Self::percent_encode(password));
            }
            uri.push('@');
        }
        uri.push_str(&host);
        if let Some(port) = config.port.filter(|value| *value > 0) {
            uri.push(':');
            uri.push_str(&port.to_string());
        }

        let database = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("admin");
        uri.push('/');
        uri.push_str(database);

        let mut query_params = Vec::new();
        if let Some(auth_source) = config
            .additional_fields
            .get("auth_source")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query_params.push(format!(
                "authSource={}",
                Self::percent_encode(auth_source)
            ));
        }
        if let Some(replica_set) = config
            .additional_fields
            .get("replica_set")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query_params.push(format!(
                "replicaSet={}",
                Self::percent_encode(replica_set)
            ));
        }
        query_params.push(format!("tls={}", if config.use_ssl { "true" } else { "false" }));

        if !query_params.is_empty() {
            uri.push('?');
            uri.push_str(&query_params.join("&"));
        }

        Ok(uri)
    }

    fn percent_encode(value: &str) -> String {
        value
            .bytes()
            .flat_map(|byte| match byte {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'~' => vec![byte as char].into_iter().collect::<Vec<_>>(),
                _ => format!("%{byte:02X}").chars().collect(),
            })
            .collect()
    }

    async fn database_name(&self, database: Option<&str>) -> String {
        if let Some(database) = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return database.to_string();
        }
        self.current_db.read().await.clone()
    }

    async fn database_handle(&self, database: Option<&str>) -> Database {
        let name = self.database_name(database).await;
        self.client.database(&name)
    }

    async fn collection_handle(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Collection<Document>> {
        let table_name = table.trim();
        if table_name.is_empty() {
            return Err(anyhow!("MongoDB collection name cannot be empty"));
        }
        Ok(self.database_handle(database).await.collection(table_name))
    }

    fn parse_relaxed_json_value(input: &str) -> Result<JsonValue> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Expected JSON input"));
        }

        serde_json::from_str::<JsonValue>(trimmed)
            .or_else(|_| json5::from_str::<JsonValue>(trimmed))
            .map_err(|error| anyhow!("Expected valid JSON/JSON5 input: {error}"))
    }

    fn json_value_to_bson(value: JsonValue) -> Result<Bson> {
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

    fn json_value_to_document(value: JsonValue) -> Result<Document> {
        match Self::json_value_to_bson(value)? {
            Bson::Document(document) => Ok(document),
            _ => Err(anyhow!("Expected a JSON object")),
        }
    }

    fn json_value_to_document_array(value: JsonValue) -> Result<Vec<Document>> {
        match value {
            JsonValue::Array(items) => items
                .into_iter()
                .map(Self::json_value_to_document)
                .collect::<Result<Vec<_>>>(),
            _ => Err(anyhow!("Expected a JSON array of objects")),
        }
    }

    fn bson_to_json(value: Bson) -> JsonValue {
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

    fn bson_to_grid_cell(value: Bson) -> JsonValue {
        match value {
            Bson::Document(_) | Bson::Array(_) => {
                JsonValue::String(Self::bson_to_json(value).to_string())
            }
            other => Self::bson_to_json(other),
        }
    }

    fn bson_type_name(value: &Bson) -> &'static str {
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

    fn infer_columns_from_documents(documents: &[Document]) -> Vec<ColumnInfo> {
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

    fn documents_to_rows(documents: &[Document], columns: &[ColumnInfo]) -> Vec<Vec<JsonValue>> {
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

    fn documents_to_result(
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

    fn scalar_result(
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

    async fn collect_cursor_limited(
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

    fn parse_json_document_arg(input: &str) -> Result<Document> {
        Self::json_value_to_document(Self::parse_relaxed_json_value(input)?)
    }

    fn parse_json_document_array_arg(input: &str) -> Result<Vec<Document>> {
        Self::json_value_to_document_array(Self::parse_relaxed_json_value(input)?)
    }

    fn parse_filter_document(filter: Option<&str>) -> Result<Document> {
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

    fn build_sort_document(order_by: Option<&str>, order_dir: Option<&str>) -> Option<Document> {
        let field = order_by.map(str::trim).filter(|value| !value.is_empty())?;
        let direction = match order_dir.unwrap_or("ASC").trim().to_ascii_uppercase().as_str() {
            "DESC" => -1,
            _ => 1,
        };
        let mut sort = Document::new();
        sort.insert(field.to_string(), Bson::Int32(direction));
        Some(sort)
    }

    fn insert_type_hint(
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

    async fn infer_structure(
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

    async fn infer_indexes(&self, collection: &Collection<Document>) -> Result<Vec<IndexInfo>> {
        let mut cursor = collection.list_indexes().await?;
        let mut indexes = Vec::new();
        while let Some(index) = cursor.try_next().await? {
            indexes.push(Self::index_model_to_info(index));
        }
        Ok(indexes)
    }

    fn index_model_to_info(index: IndexModel) -> IndexInfo {
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

    fn parse_object_id_from_json_value(value: &JsonValue) -> Option<ObjectId> {
        let string_value = value.as_str()?;
        if string_value.len() == 24 && string_value.chars().all(|ch| ch.is_ascii_hexdigit()) {
            ObjectId::parse_str(string_value).ok()
        } else {
            None
        }
    }

    fn row_selector_to_filter(primary_keys: &[RowKeyValue]) -> Result<Document> {
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

    fn strip_optional_semicolon(value: &str) -> &str {
        value.trim().trim_end_matches(';').trim()
    }

    fn find_matching_closer(input: &str, open: char, close: char) -> Result<usize> {
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

    fn split_top_level_args(input: &str) -> Result<Vec<String>> {
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

    fn parse_collection_call(input: &str) -> Result<(String, String, String)> {
        let trimmed = Self::strip_optional_semicolon(input);
        let after_db = trimmed
            .strip_prefix("db.")
            .ok_or_else(|| anyhow!("MongoDB commands must start with db."))?;

        let (collection, after_collection) = if let Some(after_get_collection) =
            after_db.strip_prefix("getCollection(")
        {
            let close_index = Self::find_matching_closer(after_get_collection, '(', ')')?;
            let raw_collection = after_get_collection[..close_index].trim();
            let collection_value = Self::parse_relaxed_json_value(raw_collection)?;
            let collection = collection_value
                .as_str()
                .ok_or_else(|| anyhow!("db.getCollection(...) requires a string collection name"))?;
            let remainder = after_get_collection[close_index + 1..].trim();
            (collection.to_string(), remainder)
        } else {
            let dot_index = after_db
                .find('.')
                .ok_or_else(|| anyhow!("MongoDB collection command is missing a method name"))?;
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
            return Err(anyhow!("Unexpected trailing characters after MongoDB command"));
        }

        Ok((collection, method, args))
    }

    fn parse_update_payload(input: &str) -> Result<MongoUpdatePayload> {
        let value = Self::parse_relaxed_json_value(input)?;
        if matches!(value, JsonValue::Array(_)) {
            Ok(MongoUpdatePayload::Pipeline(Self::json_value_to_document_array(
                value,
            )?))
        } else {
            Ok(MongoUpdatePayload::Document(Self::json_value_to_document(value)?))
        }
    }

    fn parse_command(input: &str) -> Result<MongoQueryCommand> {
        let trimmed = Self::strip_optional_semicolon(input);
        if trimmed.is_empty() {
            return Err(anyhow!("MongoDB command cannot be empty"));
        }

        if trimmed.starts_with('{') {
            return Ok(MongoQueryCommand::RunCommand(Self::parse_json_document_arg(
                trimmed,
            )?));
        }

        if let Some(after_run_command) = trimmed.strip_prefix("db.runCommand(") {
            let close_index = Self::find_matching_closer(after_run_command, '(', ')')?;
            let command = Self::parse_json_document_arg(after_run_command[..close_index].trim())?;
            let trailing = after_run_command[close_index + 1..].trim();
            if !trailing.is_empty() {
                return Err(anyhow!("Unexpected trailing characters after db.runCommand(...)"));
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

#[async_trait]
impl DatabaseDriver for MongoDbDriver {
    async fn ping(&self) -> Result<()> {
        self.client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .context("MongoDB ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let names = self
            .client
            .list_database_names()
            .await
            .context("Failed to list MongoDB databases")?;
        Ok(names
            .into_iter()
            .map(|name| DatabaseInfo { name, size: None })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let db_name = self.database_name(database).await;
        let tables = self
            .client
            .database(&db_name)
            .list_collection_names()
            .await
            .with_context(|| format!("Failed to list MongoDB collections for {db_name}"))?;
        Ok(tables
            .into_iter()
            .map(|name| TableInfo {
                name,
                schema: Some(db_name.clone()),
                table_type: "collection".to_string(),
                row_count: None,
                engine: Some("MongoDB".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        Ok(Vec::new())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let collection = self.collection_handle(table, database).await?;
        let columns = self.infer_structure(&collection).await?;
        let indexes = self.infer_indexes(&collection).await?;

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("collection".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let command = Self::parse_command(sql)?;
        let active_database = self.current_db.read().await.clone();

        let result = match command {
            MongoQueryCommand::RunCommand(command) => {
                let response = self
                    .client
                    .database(&active_database)
                    .run_command(command)
                    .await
                    .with_context(|| {
                        format!("Failed to run MongoDB command against {active_database}")
                    })?;
                Self::documents_to_result(
                    vec![response],
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    0,
                    false,
                )
            }
            MongoQueryCommand::Find { collection, filter } => {
                let cursor = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .find(filter)
                    .limit(MAX_QUERY_RESULT_ROWS as i64)
                    .await
                    .with_context(|| format!("Failed to query MongoDB collection {collection}"))?;
                let (documents, truncated) = Self::collect_cursor_limited(cursor).await?;
                Self::documents_to_result(
                    documents,
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    0,
                    truncated,
                )
            }
            MongoQueryCommand::FindOne { collection, filter } => {
                let document = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .find_one(filter)
                    .await
                    .with_context(|| format!("Failed to query MongoDB collection {collection}"))?;
                Self::documents_to_result(
                    document.into_iter().collect(),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    0,
                    false,
                )
            }
            MongoQueryCommand::Aggregate {
                collection,
                pipeline,
            } => {
                let cursor = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .aggregate(pipeline)
                    .await
                    .with_context(|| format!("Failed to aggregate MongoDB collection {collection}"))?;
                let (documents, truncated) = Self::collect_cursor_limited(cursor).await?;
                Self::documents_to_result(
                    documents,
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    0,
                    truncated,
                )
            }
            MongoQueryCommand::CountDocuments { collection, filter } => {
                let count = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .count_documents(filter)
                    .await
                    .with_context(|| format!("Failed to count MongoDB documents in {collection}"))?;
                Self::scalar_result(
                    "count",
                    JsonValue::from(count),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    0,
                )
            }
            MongoQueryCommand::InsertOne {
                collection,
                document,
            } => {
                let insert = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .insert_one(document)
                    .await
                    .with_context(|| format!("Failed to insert into MongoDB collection {collection}"))?;
                Self::scalar_result(
                    "inserted_id",
                    Self::bson_to_json(insert.inserted_id),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    1,
                )
            }
            MongoQueryCommand::InsertMany {
                collection,
                documents,
            } => {
                let inserted_count = documents.len() as u64;
                self.client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .insert_many(documents)
                    .await
                    .with_context(|| format!("Failed to insert into MongoDB collection {collection}"))?;
                Self::scalar_result(
                    "inserted_count",
                    JsonValue::from(inserted_count),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    inserted_count,
                )
            }
            MongoQueryCommand::UpdateOne {
                collection,
                filter,
                update,
            } => {
                let modified_count = match update {
                    MongoUpdatePayload::Document(update_document) => self
                        .client
                        .database(&active_database)
                        .collection::<Document>(&collection)
                        .update_one(filter, update_document)
                        .await
                        .with_context(|| format!("Failed to update MongoDB collection {collection}"))?
                        .modified_count,
                    MongoUpdatePayload::Pipeline(update_pipeline) => self
                        .client
                        .database(&active_database)
                        .collection::<Document>(&collection)
                        .update_one(filter, update_pipeline)
                        .await
                        .with_context(|| format!("Failed to update MongoDB collection {collection}"))?
                        .modified_count,
                };
                Self::scalar_result(
                    "modified_count",
                    JsonValue::from(modified_count),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    modified_count,
                )
            }
            MongoQueryCommand::UpdateMany {
                collection,
                filter,
                update,
            } => {
                let modified_count = match update {
                    MongoUpdatePayload::Document(update_document) => self
                        .client
                        .database(&active_database)
                        .collection::<Document>(&collection)
                        .update_many(filter, update_document)
                        .await
                        .with_context(|| format!("Failed to update MongoDB collection {collection}"))?
                        .modified_count,
                    MongoUpdatePayload::Pipeline(update_pipeline) => self
                        .client
                        .database(&active_database)
                        .collection::<Document>(&collection)
                        .update_many(filter, update_pipeline)
                        .await
                        .with_context(|| format!("Failed to update MongoDB collection {collection}"))?
                        .modified_count,
                };
                Self::scalar_result(
                    "modified_count",
                    JsonValue::from(modified_count),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    modified_count,
                )
            }
            MongoQueryCommand::DeleteOne { collection, filter } => {
                let deleted_count = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .delete_one(filter)
                    .await
                    .with_context(|| format!("Failed to delete from MongoDB collection {collection}"))?
                    .deleted_count;
                Self::scalar_result(
                    "deleted_count",
                    JsonValue::from(deleted_count),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    deleted_count,
                )
            }
            MongoQueryCommand::DeleteMany { collection, filter } => {
                let deleted_count = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection)
                    .delete_many(filter)
                    .await
                    .with_context(|| format!("Failed to delete from MongoDB collection {collection}"))?
                    .deleted_count;
                Self::scalar_result(
                    "deleted_count",
                    JsonValue::from(deleted_count),
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    deleted_count,
                )
            }
        };

        Ok(result)
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
        let started_at = Instant::now();
        let collection = self.collection_handle(table, database).await?;
        let filter_document = Self::parse_filter_document(filter)?;
        let mut action = collection.find(filter_document).skip(offset);
        if limit > 0 {
            action = action.limit(limit.min(MAX_QUERY_RESULT_ROWS as u64) as i64);
        } else {
            action = action.limit(MAX_QUERY_RESULT_ROWS as i64);
        }
        if let Some(sort_document) = Self::build_sort_document(order_by, order_dir) {
            action = action.sort(sort_document);
        }
        let cursor = action.await?;
        let (documents, truncated) = Self::collect_cursor_limited(cursor).await?;
        Ok(Self::documents_to_result(
            documents,
            started_at.elapsed().as_millis(),
            format!("MongoDB collection scan: {table}"),
            0,
            truncated,
        ))
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let collection = self.collection_handle(table, database).await?;
        let count = collection
            .estimated_document_count()
            .await
            .with_context(|| format!("Failed to count MongoDB documents in {table}"))?;
        Ok(count as i64)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let collection = self.collection_handle(table, database).await?;
        let mut filter = Document::new();
        filter.insert(column.trim(), Bson::Null);
        let count = collection
            .count_documents(filter)
            .await
            .with_context(|| format!("Failed to count MongoDB null values in {table}.{column}"))?;
        Ok(count as i64)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let collection = self
            .collection_handle(&request.table, request.database.as_deref())
            .await?;
        let filter = Self::row_selector_to_filter(&request.primary_keys)?;
        let mut set_document = Document::new();
        set_document.insert(
            request.target_column.clone(),
            Self::json_value_to_bson(request.value.clone())?,
        );
        let result = collection
            .update_one(filter, doc! { "$set": set_document })
            .await
            .with_context(|| format!("Failed to update MongoDB collection {}", request.table))?;
        Ok(result.modified_count)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        let collection = self
            .collection_handle(&request.table, request.database.as_deref())
            .await?;
        let mut deleted = 0u64;
        for row in &request.rows {
            let filter = Self::row_selector_to_filter(row)?;
            deleted += collection
                .delete_one(filter)
                .await
                .with_context(|| format!("Failed to delete from MongoDB collection {}", request.table))?
                .deleted_count;
        }
        Ok(deleted)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let collection = self
            .collection_handle(&request.table, request.database.as_deref())
            .await?;
        let mut document = Document::new();
        for (key, value) in &request.values {
            document.insert(key.clone(), Self::json_value_to_bson(value.clone())?);
        }
        collection
            .insert_one(document)
            .await
            .with_context(|| format!("Failed to insert into MongoDB collection {}", request.table))?;
        Ok(1)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let database_name = database.trim();
        if database_name.is_empty() {
            return Err(anyhow!("MongoDB database name cannot be empty"));
        }
        self.client
            .database(database_name)
            .run_command(doc! { "ping": 1 })
            .await
            .with_context(|| format!("Failed to switch to MongoDB database {database_name}"))?;
        let mut current_db = self.current_db.write().await;
        *current_db = database_name.to_string();
        Ok(())
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
        self.current_db.try_read().ok().map(|value| value.clone())
    }

    fn driver_name(&self) -> &str {
        "MongoDB"
    }
}

#[cfg(test)]
mod tests {
    use super::{MongoDbDriver, MongoQueryCommand, MongoUpdatePayload};
    use mongodb::bson::Bson;

    #[test]
    fn parses_run_command_with_relaxed_json() {
        let parsed = MongoDbDriver::parse_command("db.runCommand({ ping: 1 })").unwrap();
        match parsed {
            MongoQueryCommand::RunCommand(command) => {
                assert!(matches!(
                    command.get("ping"),
                    Some(Bson::Int32(1)) | Some(Bson::Int64(1))
                ));
            }
            _ => panic!("expected run command"),
        }
    }

    #[test]
    fn parses_find_command_with_get_collection() {
        let parsed =
            MongoDbDriver::parse_command("db.getCollection('users').find({ status: 'active' })")
                .unwrap();
        match parsed {
            MongoQueryCommand::Find { collection, filter } => {
                assert_eq!(collection, "users");
                assert_eq!(filter.get_str("status").unwrap(), "active");
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn parses_update_many_pipeline() {
        let parsed = MongoDbDriver::parse_command(
            "db.users.updateMany({ role: 'user' }, [{ $set: { active: true } }])",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::UpdateMany { update, .. } => match update {
                MongoUpdatePayload::Pipeline(stages) => {
                    assert_eq!(stages.len(), 1);
                    assert!(matches!(stages[0].get("$set"), Some(Bson::Document(_))));
                }
                _ => panic!("expected pipeline update"),
            },
            _ => panic!("expected updateMany command"),
        }
    }
}
