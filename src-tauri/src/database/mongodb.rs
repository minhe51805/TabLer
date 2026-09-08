use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database};
use serde_json::Value as JsonValue;
use std::time::Instant;
use tokio::sync::RwLock;

pub struct MongoDbDriver {
    client: Client,
    current_db: RwLock<String>,
}

#[derive(Debug)]
pub(super) enum MongoQueryCommand {
    RunCommand(Document),
    Find {
        collection: String,
        filter: Document,
        projection: Option<Document>,
        sort: Option<Document>,
        limit: Option<i64>,
        skip: Option<u64>,
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

#[derive(Debug)]
pub(super) enum MongoUpdatePayload {
    Document(Document),
    Pipeline(Vec<Document>),
}

/// Strips a `<database>.` prefix from a table reference when it names the
/// currently resolved database. MongoDB's list_tables reports the database as
/// the schema, so SQL-style callers (the Explorer tab opener, the AI tooling)
/// hand over names like "avtech_operations.users" — a dotted collection name
/// that does not exist and silently reads as empty. A genuine collection
/// named exactly "<db>.<something>" collides only in pathological cases.
fn strip_database_prefix<'a>(table: &'a str, db_name: &str) -> &'a str {
    let db_prefix = format!("{db_name}.");
    table.strip_prefix(db_prefix.as_str()).unwrap_or(table)
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

        // Detect Atlas/SRV targets: either an explicit `mongodb+srv://` scheme
        // pasted into the host field or an official Atlas hostname. SRV is
        // required to discover the cluster (plain mongodb:// only reaches one
        // node and Atlas rejects it), and SRV connections are always TLS.
        // `.mongodb.net` is reserved for Atlas so the bare-hostname heuristic
        // cannot misfire on self-hosted servers. Escape hatch for the rare
        // non-SRV Atlas target (e.g. PrivateLink endpoints, whose hostnames
        // still end in .mongodb.net but have no SRV records): prefix the host
        // with `mongodb://` to disable SRV discovery.
        let mut is_srv = false;
        let mut host = raw_host.to_string();
        if let Some(rest) = host.strip_prefix("mongodb+srv://") {
            is_srv = true;
            host = rest.to_string();
        } else if let Some(rest) = host.strip_prefix("mongodb://") {
            host = rest.to_string();
        } else if host
            .split('/')
            .next()
            .is_some_and(|host_part| host_part.trim_end_matches('.').ends_with(".mongodb.net"))
        {
            is_srv = true;
        }
        // A full connection URL pasted into the host field: keep only the
        // host portion, dropping any embedded `user:pass@` credentials (the
        // structured username/password fields are authoritative). An embedded
        // path is ignored in favor of config.database.
        host = host.split('/').next().unwrap_or_default().to_string();
        if let Some((_, without_credentials)) = host.rsplit_once('@') {
            host = without_credentials.to_string();
        }
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host
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

        let mut uri = String::from(if is_srv {
            "mongodb+srv://"
        } else {
            "mongodb://"
        });
        if let Some(username) = username {
            uri.push_str(&Self::percent_encode(username));
            if let Some(password) = password {
                uri.push(':');
                uri.push_str(&Self::percent_encode(password));
            }
            uri.push('@');
        }
        uri.push_str(&host);
        // SRV records already encode the port — appending one is invalid.
        if !is_srv {
            if let Some(port) = config.port.filter(|value| *value > 0) {
                uri.push(':');
                uri.push_str(&port.to_string());
            }
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
            query_params.push(format!("authSource={}", Self::percent_encode(auth_source)));
        }
        if let Some(replica_set) = config
            .additional_fields
            .get("replica_set")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query_params.push(format!("replicaSet={}", Self::percent_encode(replica_set)));
        }
        // Atlas users live in the admin database, but the URI path carries the
        // target database — without an explicit authSource the server would
        // look the user up there and fail. Only defaulted for SRV targets;
        // explicit auth_source always wins.
        if is_srv
            && username.is_some()
            && !query_params
                .iter()
                .any(|param| param.starts_with("authSource="))
        {
            query_params.push("authSource=admin".to_string());
        }
        query_params.push(format!(
            "tls={}",
            // SRV targets are Atlas, which rejects plain connections.
            if is_srv || config.use_ssl {
                "true"
            } else {
                "false"
            }
        ));

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
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    vec![byte as char].into_iter().collect::<Vec<_>>()
                }
                _ => format!("%{byte:02X}").chars().collect(),
            })
            .collect()
    }

    async fn database_name(&self, database: Option<&str>) -> String {
        if let Some(database) = database.map(str::trim).filter(|value| !value.is_empty()) {
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
        // SQL-style callers pass schema-qualified names (`<db>.<collection>`)
        // because MongoDB's list_tables reports the database as the schema —
        // the Explorer then opens tabs like "avtech_operations.users", which
        // reads as a nonexistent dotted collection and silently yields zero
        // rows. Strip the resolved-database prefix; a real collection sharing
        // that exact dotted name is pathological enough to accept.
        let db_name = self.database_name(database).await;
        let collection_name = strip_database_prefix(table_name, &db_name);
        Ok(self
            .database_handle(database)
            .await
            .collection(collection_name))
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
                create_date: None,
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
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                let collection_name = strip_database_prefix(&collection, &active_database);
                let effective_limit = limit
                    .unwrap_or(MAX_QUERY_RESULT_ROWS as i64)
                    .clamp(0, MAX_QUERY_RESULT_ROWS as i64);
                let database = self.client.database(&active_database);
                let collection_handle = database.collection::<Document>(collection_name);
                let mut find_action = collection_handle.find(filter);
                if let Some(projection) = projection {
                    find_action = find_action.projection(projection);
                }
                if let Some(sort) = sort {
                    find_action = find_action.sort(sort);
                }
                if let Some(skip) = skip {
                    find_action = find_action.skip(skip);
                }
                find_action = find_action.limit(effective_limit);
                let cursor = find_action
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
                let collection_name = strip_database_prefix(&collection, &active_database);
                let document = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(collection_name)
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
                    .with_context(|| {
                        format!("Failed to aggregate MongoDB collection {collection}")
                    })?;
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
                    .with_context(|| {
                        format!("Failed to count MongoDB documents in {collection}")
                    })?;
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
                    .with_context(|| {
                        format!("Failed to insert into MongoDB collection {collection}")
                    })?;
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
                    .with_context(|| {
                        format!("Failed to insert into MongoDB collection {collection}")
                    })?;
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
                    MongoUpdatePayload::Document(update_document) => {
                        self.client
                            .database(&active_database)
                            .collection::<Document>(&collection)
                            .update_one(filter, update_document)
                            .await
                            .with_context(|| {
                                format!("Failed to update MongoDB collection {collection}")
                            })?
                            .modified_count
                    }
                    MongoUpdatePayload::Pipeline(update_pipeline) => {
                        self.client
                            .database(&active_database)
                            .collection::<Document>(&collection)
                            .update_one(filter, update_pipeline)
                            .await
                            .with_context(|| {
                                format!("Failed to update MongoDB collection {collection}")
                            })?
                            .modified_count
                    }
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
                    MongoUpdatePayload::Document(update_document) => {
                        self.client
                            .database(&active_database)
                            .collection::<Document>(&collection)
                            .update_many(filter, update_document)
                            .await
                            .with_context(|| {
                                format!("Failed to update MongoDB collection {collection}")
                            })?
                            .modified_count
                    }
                    MongoUpdatePayload::Pipeline(update_pipeline) => {
                        self.client
                            .database(&active_database)
                            .collection::<Document>(&collection)
                            .update_many(filter, update_pipeline)
                            .await
                            .with_context(|| {
                                format!("Failed to update MongoDB collection {collection}")
                            })?
                            .modified_count
                    }
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
                    .with_context(|| {
                        format!("Failed to delete from MongoDB collection {collection}")
                    })?
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
                    .with_context(|| {
                        format!("Failed to delete from MongoDB collection {collection}")
                    })?
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
                .with_context(|| {
                    format!("Failed to delete from MongoDB collection {}", request.table)
                })?
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
        collection.insert_one(document).await.with_context(|| {
            format!("Failed to insert into MongoDB collection {}", request.table)
        })?;
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
    use super::{strip_database_prefix, MongoDbDriver, MongoQueryCommand, MongoUpdatePayload};
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
            MongoQueryCommand::Find {
                collection, filter, ..
            } => {
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

    #[test]
    fn translates_select_star_from_collection() {
        let parsed = MongoDbDriver::parse_command("Select * From users").unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                assert_eq!(collection, "users");
                assert!(filter.is_empty());
                assert!(projection.is_none());
                assert!(sort.is_none());
                assert!(limit.is_none());
                assert!(skip.is_none());
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_select_columns_where_order_limit() {
        let parsed = MongoDbDriver::parse_command(
            "select name, profile.email from users where age >= 18 and status = 'active' \
             order by name desc limit 10 offset 5",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                assert_eq!(collection, "users");

                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(conditions.len(), 2);
                let age_condition = conditions[0].as_document().unwrap();
                assert_eq!(
                    age_condition
                        .get_document("age")
                        .unwrap()
                        .get_i64("$gte")
                        .unwrap(),
                    18
                );
                let status_condition = conditions[1].as_document().unwrap();
                assert_eq!(status_condition.get_str("status").unwrap(), "active");

                let projection = projection.unwrap();
                assert_eq!(projection.get_i32("name").unwrap(), 1);
                assert_eq!(projection.get_i32("profile.email").unwrap(), 1);
                assert_eq!(projection.get_i32("_id").unwrap(), 0);

                assert_eq!(sort.unwrap().get_i32("name").unwrap(), -1);
                assert_eq!(limit, Some(10));
                assert_eq!(skip, Some(5));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_select_count_star() {
        let parsed = MongoDbDriver::parse_command("SELECT COUNT(*) FROM users").unwrap();
        match parsed {
            MongoQueryCommand::CountDocuments { collection, filter } => {
                assert_eq!(collection, "users");
                assert!(filter.is_empty());
            }
            _ => panic!("expected count command"),
        }
    }

    #[test]
    fn translates_where_operators() {
        let parsed = MongoDbDriver::parse_command(
            "select * from users where role in ('admin', 'editor') and deleted_at is null \
             and name like 'jo%' and age not between 30 and 40",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find { filter, .. } => {
                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(conditions.len(), 4);

                let roles = conditions[0]
                    .as_document()
                    .unwrap()
                    .get_document("role")
                    .unwrap()
                    .get_array("$in")
                    .unwrap();
                assert_eq!(roles.len(), 2);
                assert_eq!(roles[0].as_str().unwrap(), "admin");

                let deleted_at = conditions[1].as_document().unwrap();
                assert_eq!(deleted_at.get("deleted_at").unwrap(), &Bson::Null);

                let name = conditions[2]
                    .as_document()
                    .unwrap()
                    .get_document("name")
                    .unwrap();
                assert_eq!(name.get_str("$regex").unwrap(), "^jo.*$");
                assert_eq!(name.get_str("$options").unwrap(), "i");

                let age = conditions[3]
                    .as_document()
                    .unwrap()
                    .get_document("age")
                    .unwrap();
                assert!(age.get_document("$not").is_ok());
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_group_by_with_count() {
        let parsed = MongoDbDriver::parse_command(
            "select status, count(*) as total from users group by status order by total desc limit 5",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Aggregate {
                collection,
                pipeline,
            } => {
                assert_eq!(collection, "users");
                assert_eq!(pipeline.len(), 4);

                let group = pipeline[0].get_document("$group").unwrap();
                assert_eq!(
                    group
                        .get_document("_id")
                        .unwrap()
                        .get_str("status")
                        .unwrap(),
                    "$status"
                );
                assert_eq!(
                    group
                        .get_document("total")
                        .unwrap()
                        .get_i32("$sum")
                        .unwrap(),
                    1
                );

                let project = pipeline[1].get_document("$project").unwrap();
                assert_eq!(project.get_str("status").unwrap(), "$_id.status");
                assert_eq!(project.get_i32("total").unwrap(), 1);
                assert_eq!(project.get_i32("_id").unwrap(), 0);

                assert_eq!(
                    pipeline[2]
                        .get_document("$sort")
                        .unwrap()
                        .get_i32("total")
                        .unwrap(),
                    -1
                );
                assert_eq!(pipeline[3].get_i64("$limit").unwrap(), 5);
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_sum_with_where() {
        let parsed =
            MongoDbDriver::parse_command("select sum(amount) from orders where user_id = 7")
                .unwrap();
        match parsed {
            MongoQueryCommand::Aggregate { pipeline, .. } => {
                assert_eq!(pipeline.len(), 2);
                let match_stage = pipeline[0].get_document("$match").unwrap();
                assert_eq!(match_stage.get_i64("user_id").unwrap(), 7);
                let group = pipeline[1].get_document("$group").unwrap();
                assert_eq!(group.get("_id"), Some(&Bson::Null));
                assert_eq!(
                    group
                        .get_document("sum_amount")
                        .unwrap()
                        .get_str("$sum")
                        .unwrap(),
                    "$amount"
                );
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_alias_projection() {
        let parsed =
            MongoDbDriver::parse_command("select name as full_name from users limit 3").unwrap();
        match parsed {
            MongoQueryCommand::Aggregate { pipeline, .. } => {
                assert_eq!(pipeline.len(), 2);
                let project = pipeline[0].get_document("$project").unwrap();
                assert_eq!(project.get_str("full_name").unwrap(), "$name");
                assert_eq!(project.get_i32("_id").unwrap(), 0);
                assert_eq!(pipeline[1].get_i64("$limit").unwrap(), 3);
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_distinct_columns() {
        let parsed = MongoDbDriver::parse_command("select distinct city from users").unwrap();
        match parsed {
            MongoQueryCommand::Aggregate { pipeline, .. } => {
                assert_eq!(pipeline.len(), 2);
                let group = pipeline[0].get_document("$group").unwrap();
                assert_eq!(
                    group.get_document("_id").unwrap().get_str("city").unwrap(),
                    "$city"
                );
                let project = pipeline[1].get_document("$project").unwrap();
                assert_eq!(project.get_str("city").unwrap(), "$_id.city");
                assert_eq!(project.get_i32("_id").unwrap(), 0);
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_object_id_equality() {
        let parsed = MongoDbDriver::parse_command(
            "select * from users where _id = '507f1f77bcf86cd799439011'",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find { filter, .. } => {
                assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_or_and_not() {
        let parsed = MongoDbDriver::parse_command(
            "select * from users where (role = 'admin' or role = 'editor') and not banned = true",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find { filter, .. } => {
                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(conditions.len(), 2);
                let or_clause = conditions[0].as_document().unwrap();
                assert_eq!(or_clause.get_array("$or").unwrap().len(), 2);
                let nor = conditions[1]
                    .as_document()
                    .unwrap()
                    .get_array("$nor")
                    .unwrap();
                let banned = nor[0].as_document().unwrap();
                assert_eq!(banned.get("banned").unwrap(), &Bson::Boolean(true));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn sql_writes_get_shell_hints() {
        for (sql, hint) in [
            ("insert into users (name) values ('x')", "insertOne"),
            ("update users set name = 'x' where _id = 1", "updateOne"),
            ("delete from users where _id = 1", "deleteOne"),
            ("create table users (id int)", "createCollection"),
        ] {
            let error = MongoDbDriver::parse_command(sql).unwrap_err().to_string();
            assert!(
                error.contains(hint),
                "error for '{sql}' should mention '{hint}': {error}"
            );
        }
    }

    #[test]
    fn shell_find_keeps_default_options() {
        let parsed = MongoDbDriver::parse_command("db.users.find({ age: { $gte: 18 } })").unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                projection,
                sort,
                limit,
                skip,
                ..
            } => {
                assert_eq!(collection, "users");
                assert!(projection.is_none());
                assert!(sort.is_none());
                assert!(limit.is_none());
                assert!(skip.is_none());
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn non_sql_non_shell_input_reports_shell_requirement() {
        let error = MongoDbDriver::parse_command("show dbs")
            .unwrap_err()
            .to_string();
        assert!(error.contains("must start with db."));
    }

    #[test]
    fn broken_select_reports_translation_error() {
        let error = MongoDbDriver::parse_command("select from where")
            .unwrap_err()
            .to_string();
        assert!(error.contains("could not be translated"));
    }

    #[test]
    fn multiple_sql_statements_are_rejected() {
        assert!(MongoDbDriver::parse_command("select * from users; select * from teams").is_err());
    }

    fn config_with(
        host: &str,
        username: Option<&str>,
        password: Option<&str>,
        database: Option<&str>,
    ) -> crate::database::models::ConnectionConfig {
        crate::database::models::ConnectionConfig {
            host: Some(host.to_string()),
            username: username.map(str::to_string),
            password: password.map(str::to_string),
            database: database.map(str::to_string),
            ..crate::database::models::ConnectionConfig::default()
        }
    }

    #[test]
    fn atlas_host_builds_srv_uri_with_admin_auth_source() {
        let config = config_with(
            "cluster0.67gwy4b.mongodb.net",
            Some("avtech_operations_db_user"),
            Some("secret"),
            Some("avtech_operations"),
        );
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(uri.starts_with("mongodb+srv://"));
        assert!(uri.contains("authSource=admin"));
        assert!(uri.contains("tls=true"));
        assert!(!uri.contains(":27017"), "SRV URIs must not carry a port");
        assert!(
            uri.contains("/avtech_operations?"),
            "target db must be the URI path: {uri}"
        );
    }

    #[test]
    fn pasted_connection_url_host_is_reduced_to_the_host_part() {
        let config = config_with(
            "avtech_operations_db_user:pw@cluster0.67gwy4b.mongodb.net/avtech_operations?retryWrites=true",
            None,
            None,
            None,
        );
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(uri.starts_with("mongodb+srv://"));
        assert!(uri.contains("cluster0.67gwy4b.mongodb.net"));
        assert!(!uri.contains("avtech_operations_db_user"));
        assert!(!uri.contains("retryWrites"));
    }

    #[test]
    fn local_host_keeps_plain_scheme_and_port() {
        let config = crate::database::models::ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            username: Some("dev".to_string()),
            password: Some("dev".to_string()),
            database: Some("localdb".to_string()),
            ..crate::database::models::ConnectionConfig::default()
        };
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(uri.starts_with("mongodb://"));
        assert!(uri.contains("localhost:27017"));
        assert!(!uri.contains("authSource=admin"));
        assert!(uri.contains("tls=false"));
    }

    /// Live diagnostic against a real Atlas cluster. Run manually:
    /// `cargo test --lib mongo_live_probe -- --ignored --nocapture`
    /// Requires TABLER_TEST_MONGO_URI (full mongodb+srv connection string).
    #[tokio::test]
    #[ignore = "requires TABLER_TEST_MONGO_URI"]
    async fn mongo_live_probe() {
        use crate::database::driver::DatabaseDriver;
        // CI runs with --include-ignored on machines without a live cluster:
        // skip quietly instead of panicking when the URI is not configured.
        let uri = match std::env::var("TABLER_TEST_MONGO_URI") {
            Ok(uri) => uri,
            Err(_) => {
                eprintln!("skipping mongo_live_probe: TABLER_TEST_MONGO_URI is not set");
                return;
            }
        };
        // The embedded credentials must go through the structured fields (the
        // builder strips them from the host on purpose). Without them the
        // connection is anonymous — MongoDB's ping succeeds unauthenticated,
        // which masks the missing credentials until the first real command.
        let authority = uri
            .split("//")
            .nth(1)
            .and_then(|rest| rest.split('@').next())
            .unwrap_or_default();
        let (username, password) = match authority.split_once(':') {
            Some((user, pass)) => (Some(user.to_string()), Some(pass.to_string())),
            None => (None, None),
        };
        let config = crate::database::models::ConnectionConfig {
            id: "mongo-probe".to_string(),
            name: "mongo-probe".to_string(),
            db_type: crate::database::models::DatabaseType::MongoDB,
            host: Some(uri),
            port: None,
            username,
            password,
            database: Some("avtech_operations".to_string()),
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: std::collections::HashMap::new(),
            startup_commands: None,
            pre_connect_script: None,
            ssh_config: None,
        };
        let driver = MongoDbDriver::connect(&config).await.expect("connect");
        // Note: Atlas users scoped to a single database lack listDatabases on
        // admin — that call panics the probe, so it stays removed here.
        let tables = driver
            .list_tables(Some("avtech_operations"))
            .await
            .expect("list_tables");
        println!(
            "[probe] avtech_operations collections: {:?}",
            tables.iter().map(|t| &t.name).collect::<Vec<_>>()
        );

        for collection in ["users", "projects", "teams"] {
            match driver
                .count_rows(collection, Some("avtech_operations"))
                .await
            {
                Ok(count) => println!("[probe] {collection}: count={count}"),
                Err(error) => println!("[probe] {collection}: count ERROR: {error:#}"),
            }
            match driver
                .get_table_data(
                    collection,
                    Some("avtech_operations"),
                    0,
                    10,
                    None,
                    None,
                    None,
                )
                .await
            {
                Ok(data) => println!(
                    "[probe] {collection}: fetched={} columns={:?} first_row={:?}",
                    data.rows.len(),
                    data.columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
                    data.rows.first().map(|row| row.first()),
                ),
                Err(error) => println!("[probe] {collection}: fetch ERROR: {error:#}"),
            }
        }
    }

    #[test]
    fn strips_schema_qualified_collection_prefix() {
        // The Explorer opens tabs as "<db>.<collection>" because MongoDB's
        // list_tables reports the database as the schema.
        assert_eq!(
            strip_database_prefix("avtech_operations.users", "avtech_operations"),
            "users"
        );
        // Already-bare names pass through untouched.
        assert_eq!(strip_database_prefix("users", "avtech_operations"), "users");
        // A different database prefix is NOT stripped.
        assert_eq!(
            strip_database_prefix("other_db.users", "avtech_operations"),
            "other_db.users"
        );
        // The bare database name itself is left alone.
        assert_eq!(
            strip_database_prefix("avtech_operations", "avtech_operations"),
            "avtech_operations"
        );
    }
}
