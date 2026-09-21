use super::{strip_database_prefix, MongoDbDriver, MongoQueryCommand, MongoUpdatePayload};
use crate::commands::profiler::{PROBE_ROW_LIMIT, PROFILER_COLUMNS, TOP_QUERY_COLUMNS};
use crate::database::driver::DatabaseDriver;
use crate::database::models::*;
use crate::database::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value as JsonValue;
use std::pin::Pin;
use std::time::Instant;

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

    /// Live trace: sample active operations via the admin `$currentOp`
    /// aggregation and map them onto the canonical profiler columns.
    async fn profiler_live_sample(&self) -> Result<QueryResult> {
        let started_at = Instant::now();
        let cursor = self.current_op_cursor().await?;
        let (documents, truncated) = Self::collect_cursor_limited(cursor).await?;
        let rows = documents
            .into_iter()
            .filter_map(Self::current_op_to_row)
            .collect::<Vec<_>>();
        Ok(Self::canonical_result(
            &PROFILER_COLUMNS,
            rows,
            "db.aggregate([{ $currentOp: {} }])".to_string(),
            started_at.elapsed().as_millis(),
            truncated,
        ))
    }

    /// Top Queries: rank the current database's `system.profile` capped
    /// collection by cumulative time, grouped by operation and namespace.
    async fn profiler_top_sample(&self) -> Result<QueryResult> {
        let started_at = Instant::now();
        let active_database = self.current_db.read().await.clone();
        let pipeline = vec![
            doc! { "$match": { "millis": { "$exists": true } } },
            doc! { "$group": {
                "_id": { "op": "$op", "ns": "$ns" },
                "calls": { "$sum": 1 },
                "total_ms": { "$sum": "$millis" },
                "rows": { "$sum": { "$ifNull": ["$nreturned", 0] } }
            } },
            doc! { "$sort": { "total_ms": -1 } },
            doc! { "$limit": i64::from(PROBE_ROW_LIMIT) },
        ];
        let cursor = self
            .client
            .database(&active_database)
            .collection::<Document>("system.profile")
            .aggregate(pipeline)
            .await
            .with_context(|| {
                format!("Failed to read MongoDB system.profile on {active_database}")
            })?;
        let (documents, truncated) = Self::collect_cursor_limited(cursor).await?;
        let rows = documents
            .into_iter()
            .filter_map(Self::profile_group_to_row)
            .collect::<Vec<_>>();
        // An empty ranking almost always means profiling is disabled on this
        // database (`system.profile` is then never populated), which would
        // otherwise render as a silently blank table. Confirm the level and
        // surface an actionable hint instead of leaving the user guessing.
        if rows.is_empty() && !self.profiling_enabled(&active_database).await {
            return Err(anyhow!(
                "MongoDB database profiling is disabled on '{active_database}', so there are no \
                 recorded operations to rank. Enable it in mongosh with db.setProfilingLevel(1) \
                 (slow ops) or db.setProfilingLevel(2) (all ops), let some queries run, then refresh."
            ));
        }
        Ok(Self::canonical_result(
            &TOP_QUERY_COLUMNS,
            rows,
            "system.profile aggregation".to_string(),
            started_at.elapsed().as_millis(),
            truncated,
        ))
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

    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        let batch_size = usize::try_from(batch_size.max(1)).unwrap_or(usize::MAX);
        let setup = async move {
            let collection = self.collection_handle(table, database).await?;
            let filter_document = Self::parse_filter_document(filter)?;
            let mut action = collection.find(filter_document);
            if let Some(sort_document) = Self::build_sort_document(order_by, order_dir) {
                action = action.sort(sort_document);
            }
            // One server cursor streams the whole collection; the interactive
            // row cap does not apply to exports.
            let cursor = action
                .await
                .with_context(|| format!("Failed to export MongoDB collection {table}"))?;
            let query_label = format!("MongoDB collection export: {table}");

            Ok::<_, anyhow::Error>(stream::try_unfold(cursor, move |mut cursor| {
                let query_label = query_label.clone();
                async move {
                    let mut documents = Vec::new();
                    while documents.len() < batch_size {
                        let Some(document) = cursor.try_next().await? else {
                            break;
                        };
                        documents.push(document);
                    }
                    if documents.is_empty() {
                        return Ok(None);
                    }
                    let result = Self::documents_to_result(documents, 0, query_label, 0, false);
                    Ok(Some((result, cursor)))
                }
            }))
        };
        stream::once(setup).try_flatten().boxed()
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
