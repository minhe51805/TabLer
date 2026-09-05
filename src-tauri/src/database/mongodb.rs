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

pub(super) enum MongoQueryCommand {
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

pub(super) enum MongoUpdatePayload {
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
        query_params.push(format!(
            "tls={}",
            if config.use_ssl { "true" } else { "false" }
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
        Ok(self.database_handle(database).await.collection(table_name))
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
