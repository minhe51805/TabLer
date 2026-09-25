use super::{strip_database_prefix, MongoDbDriver, MongoQueryCommand, MongoUpdatePayload};
use crate::commands::profiler::{PROBE_ROW_LIMIT, PROFILER_COLUMNS, TOP_QUERY_COLUMNS};
use crate::database::driver::DatabaseDriver;
use crate::database::models::*;
use crate::database::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard};
use crate::database::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use mongodb::bson::{doc, Bson, Document};
use mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT;
use mongodb::{ClientSession, Collection, SessionCursor};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Documents per `insert_many` call inside an import transaction. The driver
/// splits oversized payloads on its own; this bound exists so the cancel flag
/// is polled between batches instead of only once per collection.
const MONGO_TXN_INSERT_BATCH: usize = 1_000;

impl MongoDbDriver {
    /// Shared body of `execute_query`/`execute_query_for_request`. `comment`
    /// tags the server-side op so a cancel can locate it in `$currentOp`;
    /// `session` pins the command to a transaction for write previews.
    async fn execute_command(
        &self,
        sql: &str,
        comment: Option<Bson>,
        mut session: Option<&mut ClientSession>,
    ) -> Result<QueryResult> {
        let started_at = Instant::now();
        // `EXPLAIN <statement>` never reaches the shell parser: the inner
        // statement is parsed like any other command, then wrapped as
        // `{ explain: <command>, verbosity: ... }` and run via runCommand.
        if let Some((inner, analyze)) = Self::strip_explain_prefix(sql) {
            return self
                .execute_explain(inner, analyze, sql, comment, session)
                .await;
        }
        let command = Self::parse_command(sql)?;
        let active_database = self.current_db.read().await.clone();

        let result = match command {
            MongoQueryCommand::RunCommand(mut command) => {
                // The comment rides inside the command document so $currentOp
                // exposes it under `command.comment` for killOp matching.
                if let Some(comment) = comment {
                    command.insert("comment", comment);
                }
                let database = self.client.database(&active_database);
                let run_action = database.run_command(command);
                // `.session()` flips the action's session type parameter, so
                // the explicit-session path must branch at the await point.
                let response = match session.as_deref_mut() {
                    Some(session) => run_action.session(session).await,
                    None => run_action.await,
                }
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
                if let Some(comment) = comment {
                    find_action = find_action.comment(comment);
                }
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
                // `.session()` flips the action's session type parameter and
                // yields a SessionCursor, so the explicit-session path must
                // branch at the await point and iterate differently.
                let (documents, truncated) = match session.as_deref_mut() {
                    Some(session) => {
                        let mut cursor =
                            find_action.session(&mut *session).await.with_context(|| {
                                format!("Failed to query MongoDB collection {collection}")
                            })?;
                        Self::collect_session_cursor_limited(&mut cursor, session).await?
                    }
                    None => {
                        let cursor = find_action.await.with_context(|| {
                            format!("Failed to query MongoDB collection {collection}")
                        })?;
                        Self::collect_cursor_limited(cursor).await?
                    }
                };
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
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(collection_name);
                let mut find_one_action = collection_handle.find_one(filter);
                if let Some(comment) = comment {
                    find_one_action = find_one_action.comment(comment);
                }
                let document = match session.as_deref_mut() {
                    Some(session) => find_one_action.session(session).await,
                    None => find_one_action.await,
                }
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
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection);
                let mut aggregate_action = collection_handle.aggregate(pipeline);
                if let Some(comment) = comment {
                    aggregate_action = aggregate_action.comment(comment);
                }
                let (documents, truncated) = match session.as_deref_mut() {
                    Some(session) => {
                        let mut cursor = aggregate_action
                            .session(&mut *session)
                            .await
                            .with_context(|| {
                                format!("Failed to aggregate MongoDB collection {collection}")
                            })?;
                        Self::collect_session_cursor_limited(&mut cursor, session).await?
                    }
                    None => {
                        let cursor = aggregate_action.await.with_context(|| {
                            format!("Failed to aggregate MongoDB collection {collection}")
                        })?;
                        Self::collect_cursor_limited(cursor).await?
                    }
                };
                Self::documents_to_result(
                    documents,
                    started_at.elapsed().as_millis(),
                    sql.to_string(),
                    0,
                    truncated,
                )
            }
            MongoQueryCommand::CountDocuments { collection, filter } => {
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection);
                let mut count_action = collection_handle.count_documents(filter);
                if let Some(comment) = comment {
                    count_action = count_action.comment(comment);
                }
                let count = match session.as_deref_mut() {
                    Some(session) => count_action.session(session).await,
                    None => count_action.await,
                }
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
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection);
                let mut insert_action = collection_handle.insert_one(document);
                if let Some(comment) = comment {
                    insert_action = insert_action.comment(comment);
                }
                let insert = match session.as_deref_mut() {
                    Some(session) => insert_action.session(session).await,
                    None => insert_action.await,
                }
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
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection);
                let mut insert_action = collection_handle.insert_many(documents);
                if let Some(comment) = comment {
                    insert_action = insert_action.comment(comment);
                }
                match session.as_deref_mut() {
                    Some(session) => insert_action.session(session).await,
                    None => insert_action.await,
                }
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
                        let collection_handle = self
                            .client
                            .database(&active_database)
                            .collection::<Document>(&collection);
                        let mut update_action =
                            collection_handle.update_one(filter, update_document);
                        if let Some(comment) = comment {
                            update_action = update_action.comment(comment);
                        }
                        match session.as_deref_mut() {
                            Some(session) => update_action.session(session).await,
                            None => update_action.await,
                        }
                        .with_context(|| {
                            format!("Failed to update MongoDB collection {collection}")
                        })?
                        .modified_count
                    }
                    MongoUpdatePayload::Pipeline(update_pipeline) => {
                        let collection_handle = self
                            .client
                            .database(&active_database)
                            .collection::<Document>(&collection);
                        let mut update_action =
                            collection_handle.update_one(filter, update_pipeline);
                        if let Some(comment) = comment {
                            update_action = update_action.comment(comment);
                        }
                        match session.as_deref_mut() {
                            Some(session) => update_action.session(session).await,
                            None => update_action.await,
                        }
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
                        let collection_handle = self
                            .client
                            .database(&active_database)
                            .collection::<Document>(&collection);
                        let mut update_action =
                            collection_handle.update_many(filter, update_document);
                        if let Some(comment) = comment {
                            update_action = update_action.comment(comment);
                        }
                        match session.as_deref_mut() {
                            Some(session) => update_action.session(session).await,
                            None => update_action.await,
                        }
                        .with_context(|| {
                            format!("Failed to update MongoDB collection {collection}")
                        })?
                        .modified_count
                    }
                    MongoUpdatePayload::Pipeline(update_pipeline) => {
                        let collection_handle = self
                            .client
                            .database(&active_database)
                            .collection::<Document>(&collection);
                        let mut update_action =
                            collection_handle.update_many(filter, update_pipeline);
                        if let Some(comment) = comment {
                            update_action = update_action.comment(comment);
                        }
                        match session.as_deref_mut() {
                            Some(session) => update_action.session(session).await,
                            None => update_action.await,
                        }
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
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection);
                let mut delete_action = collection_handle.delete_one(filter);
                if let Some(comment) = comment {
                    delete_action = delete_action.comment(comment);
                }
                let deleted_count = match session.as_deref_mut() {
                    Some(session) => delete_action.session(session).await,
                    None => delete_action.await,
                }
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
                let collection_handle = self
                    .client
                    .database(&active_database)
                    .collection::<Document>(&collection);
                let mut delete_action = collection_handle.delete_many(filter);
                if let Some(comment) = comment {
                    delete_action = delete_action.comment(comment);
                }
                let deleted_count = match session.as_mut() {
                    Some(session) => delete_action.session(&mut **session).await,
                    None => delete_action.await,
                }
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

    /// Strip a leading `EXPLAIN`/`EXPLAIN ANALYZE` prefix (comments and
    /// whitespace tolerated) so the inner statement can be wrapped in the
    /// `explain` command. Returns `(inner_sql, analyze)` or `None` when the
    /// statement is not an EXPLAIN.
    pub(super) fn strip_explain_prefix(sql: &str) -> Option<(&str, bool)> {
        let mut rest = sql.trim_start();
        loop {
            if let Some(after) = rest.strip_prefix("--") {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix("//") {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix('#') {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix("/*") {
                rest = match after.find("*/") {
                    Some(end) => &after[end + 2..],
                    None => "",
                };
                rest = rest.trim_start();
                continue;
            }
            break;
        }
        let head = rest.get(..7)?;
        if !head.eq_ignore_ascii_case("EXPLAIN") {
            return None;
        }
        let after = &rest[7..];
        if !after.starts_with(|ch: char| ch.is_whitespace() || ch == '(') {
            return None;
        }
        let mut inner = after.trim_start();
        let mut analyze = false;
        // Tolerate a Postgres-style option list: EXPLAIN (ANALYZE, COSTS) …
        if let Some(options) = inner.strip_prefix('(') {
            if let Some(close) = options.find(')') {
                if options[..close]
                    .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
                    .any(|word| word.eq_ignore_ascii_case("ANALYZE"))
                {
                    analyze = true;
                }
                inner = options[close + 1..].trim_start();
            }
        }
        if let Some(head) = inner.get(..7) {
            if head.eq_ignore_ascii_case("ANALYZE") {
                let tail = &inner[7..];
                if tail.starts_with(|ch: char| ch.is_whitespace()) {
                    analyze = true;
                    inner = tail.trim_start();
                }
            }
        }
        if inner.is_empty() {
            return None;
        }
        Some((inner, analyze))
    }

    /// Run an `EXPLAIN` statement: MongoDB has no EXPLAIN keyword — the plan
    /// comes from the `explain` command wrapping the translated inner command
    /// (`{ explain: <command>, verbosity: ... }`). `EXPLAIN` maps to
    /// `executionStats` (the plan plus observed counters; writes are still
    /// never executed) and `EXPLAIN ANALYZE` to `allPlansExecution`, which
    /// additionally times every candidate plan. The response document lands
    /// in a single-row `query_plan` JSON column, matching the shape the
    /// explain flow consumes on other drivers.
    async fn execute_explain(
        &self,
        inner_sql: &str,
        analyze: bool,
        original_sql: &str,
        comment: Option<Bson>,
        session: Option<&mut ClientSession>,
    ) -> Result<QueryResult> {
        let started_at = Instant::now();
        let inner = Self::parse_command(inner_sql)?;
        let mut command = Self::explainable_command_document(inner, analyze)?;
        // The comment rides inside the command document so $currentOp exposes
        // it under `command.comment` for killOp matching.
        if let Some(comment) = comment {
            command.insert("comment", comment);
        }
        let active_database = self.current_db.read().await.clone();
        let database = self.client.database(&active_database);
        let run_action = database.run_command(command);
        // `.session()` flips the action's session type parameter, so the
        // explicit-session path must branch at the await point.
        let response = match session {
            Some(session) => run_action.session(&mut *session).await,
            None => run_action.await,
        }
        .with_context(|| format!("Failed to explain MongoDB command against {active_database}"))?;
        let plan = Self::bson_to_json(Bson::Document(response));
        let plan_text = serde_json::to_string_pretty(&plan).unwrap_or_else(|_| plan.to_string());
        Ok(Self::scalar_result(
            "query_plan",
            JsonValue::String(plan_text),
            started_at.elapsed().as_millis(),
            original_sql.to_string(),
            0,
        ))
    }

    /// Convert a parsed command into the document the `explain` command
    /// wraps. `explain` accepts find/aggregate/count plus the write commands
    /// (insert/update/delete) — writes are planned, never executed — so every
    /// parsed variant maps. A `db.runCommand({...})` payload is wrapped
    /// verbatim unless it already IS an explain command, which runs as-is.
    pub(super) fn explainable_command_document(
        command: MongoQueryCommand,
        analyze: bool,
    ) -> Result<Document> {
        let verbosity = if analyze {
            "allPlansExecution"
        } else {
            "executionStats"
        };
        let inner = match command {
            MongoQueryCommand::RunCommand(document) => {
                if document.contains_key("explain") {
                    // Already an explain command — run it directly rather than
                    // nesting `{ explain: { explain: ... } }`.
                    return Ok(document);
                }
                document
            }
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                let mut find = doc! { "find": collection, "filter": filter };
                if let Some(projection) = projection {
                    find.insert("projection", projection);
                }
                if let Some(sort) = sort {
                    find.insert("sort", sort);
                }
                if let Some(limit) = limit {
                    find.insert("limit", limit);
                }
                if let Some(skip) = skip {
                    find.insert("skip", i64::try_from(skip).unwrap_or(i64::MAX));
                }
                find
            }
            MongoQueryCommand::FindOne { collection, filter } => {
                doc! { "find": collection, "filter": filter, "limit": 1 }
            }
            MongoQueryCommand::Aggregate {
                collection,
                pipeline,
            } => {
                // The aggregate command requires a cursor field even under
                // explain, where no cursor is ever opened.
                doc! { "aggregate": collection, "pipeline": pipeline, "cursor": Document::new() }
            }
            MongoQueryCommand::CountDocuments { collection, filter } => {
                doc! { "count": collection, "query": filter }
            }
            MongoQueryCommand::InsertOne {
                collection,
                document,
            } => {
                doc! { "insert": collection, "documents": [document] }
            }
            MongoQueryCommand::InsertMany {
                collection,
                documents,
            } => {
                doc! { "insert": collection, "documents": documents }
            }
            MongoQueryCommand::UpdateOne {
                collection,
                filter,
                update,
            } => {
                let update_spec = doc! {
                    "q": filter,
                    "u": Self::update_payload_to_bson(update),
                    "multi": false,
                };
                doc! { "update": collection, "updates": [update_spec] }
            }
            MongoQueryCommand::UpdateMany {
                collection,
                filter,
                update,
            } => {
                let update_spec = doc! {
                    "q": filter,
                    "u": Self::update_payload_to_bson(update),
                    "multi": true,
                };
                doc! { "update": collection, "updates": [update_spec] }
            }
            MongoQueryCommand::DeleteOne { collection, filter } => {
                // `limit: 1` deletes one matching document; `limit: 0` all.
                doc! { "delete": collection, "deletes": [doc! { "q": filter, "limit": 1 }] }
            }
            MongoQueryCommand::DeleteMany { collection, filter } => {
                doc! { "delete": collection, "deletes": [doc! { "q": filter, "limit": 0 }] }
            }
        };
        Ok(doc! { "explain": inner, "verbosity": verbosity })
    }

    /// The `u` field of an update command spec accepts either a replacement/
    /// modifier document or an aggregation pipeline (4.2+).
    fn update_payload_to_bson(update: MongoUpdatePayload) -> Bson {
        match update {
            MongoUpdatePayload::Document(document) => Bson::Document(document),
            MongoUpdatePayload::Pipeline(stages) => {
                Bson::Array(stages.into_iter().map(Bson::Document).collect())
            }
        }
    }

    /// Session-bound counterpart of `collect_cursor_limited`: a
    /// `SessionCursor` is not a `Stream`, so rows are pulled with
    /// `advance`/`deserialize_current` against the same session that created
    /// the cursor. Same row cap and truncation flag as the implicit path.
    async fn collect_session_cursor_limited(
        cursor: &mut SessionCursor<Document>,
        session: &mut ClientSession,
    ) -> Result<(Vec<Document>, bool)> {
        let mut documents = Vec::new();
        while cursor.advance(&mut *session).await? {
            if documents.len() == MAX_QUERY_RESULT_ROWS {
                return Ok((documents, true));
            }
            documents.push(cursor.deserialize_current()?);
        }
        Ok((documents, false))
    }

    /// Whether the `hello`/`isMaster` handshake describes a deployment that
    /// accepts multi-document transactions: replica set members report
    /// `setName` and mongos routers report `msg: "isdbgrid"`, while a
    /// standalone mongod reports neither.
    pub(super) fn hello_supports_transactions(hello: &Document) -> bool {
        hello.contains_key("setName")
            || hello
                .get_str("msg")
                .map(|msg| msg == "isdbgrid")
                .unwrap_or(false)
    }

    /// Lazily resolves and caches whether this deployment can run
    /// multi-document transactions. Sessions are a client-side construct, so
    /// `start_session` alone proves nothing; the `hello` response is the
    /// authoritative signal (`isMaster` is the pre-4.4 fallback).
    async fn transactions_supported(&self) -> Result<bool> {
        if let Some(cached) = *self
            .transactions_supported
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            return Ok(cached);
        }
        let admin = self.client.database("admin");
        let hello = match admin.run_command(doc! { "hello": 1 }).await {
            Ok(response) => response,
            Err(_) => admin
                .run_command(doc! { "isMaster": 1 })
                .await
                .context("Failed to probe MongoDB deployment topology")?,
        };
        let supported = Self::hello_supports_transactions(&hello);
        *self
            .transactions_supported
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(supported);
        Ok(supported)
    }

    /// Opens a `ClientSession` with a started transaction, rejecting
    /// standalone deployments up front instead of letting the first write
    /// fail mid-transaction with a less actionable server error.
    async fn begin_transaction(&self) -> Result<ClientSession> {
        if !self.transactions_supported().await? {
            return Err(anyhow!(
                "MongoDB multi-document transactions require a replica set or sharded \
                 cluster; this deployment is standalone, so atomic writes are unavailable"
            ));
        }
        let mut session = self
            .client
            .start_session()
            .await
            .context("Failed to start a MongoDB client session")?;
        session
            .start_transaction()
            .await
            .context("Failed to start a MongoDB transaction")?;
        Ok(session)
    }

    /// Commits the session's transaction, retrying while the server reports
    /// `UnknownTransactionCommitResult` — that label means the commit outcome
    /// is ambiguous, so retrying is the documented way to resolve it.
    async fn commit_transaction(session: &mut ClientSession) -> Result<()> {
        loop {
            match session.commit_transaction().await {
                Ok(()) => return Ok(()),
                Err(error) if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT) => continue,
                Err(error) => {
                    return Err(error).context("Failed to commit the MongoDB transaction")
                }
            }
        }
    }

    /// Best-effort abort: the transaction is already failed or being
    /// discarded, so an abort error is logged rather than masking the real
    /// cause. Dropping the session would abort anyway.
    async fn abort_transaction_quietly(session: &mut ClientSession) {
        if let Err(error) = session.abort_transaction().await {
            log::warn!("MongoDB transaction abort failed: {error}");
        }
    }

    /// Runs one `insert_many` batch inside the transaction session.
    async fn insert_document_batch(
        collection: &Collection<Document>,
        documents: Vec<Document>,
        session: &mut ClientSession,
    ) -> Result<u64> {
        if documents.is_empty() {
            return Ok(0);
        }
        let inserted = documents.len() as u64;
        collection
            .insert_many(documents)
            .session(&mut *session)
            .await
            .with_context(|| {
                format!(
                    "Failed to insert into MongoDB collection {}",
                    collection.name()
                )
            })?;
        Ok(inserted)
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
        self.execute_command(sql, None, None).await
    }

    /// Request-scoped execution: the parsed command is tagged with a
    /// `tabler-cancel:<request_id>` comment so `cancel_query_request` can find
    /// the live op via `$currentOp` and kill it with `killOp`.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The op is located by its comment tag, not a backend id — registering
        // a marker only resolves the pending-cancel race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let comment = Bson::String(format!("tabler-cancel:{request_id}"));
        let result = self.execute_command(sql, Some(comment), None).await;
        drop(guard);
        result
    }

    /// Cancels by locating the op whose `command.comment` carries the request
    /// tag in `$currentOp` and issuing `killOp` on admin. A vanished op means
    /// the server already finished it, which still confirms nothing is running.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => {
                let tag = format!("tabler-cancel:{request_id}");
                let cursor = self.tagged_op_cursor(&tag).await?;
                let (ops, _) = Self::collect_cursor_limited(cursor).await?;
                let Some(opid) = ops.iter().find_map(|op| op.get("opid").cloned()) else {
                    // No live op carries the tag: it already finished.
                    return Ok(true);
                };
                self.client
                    .database("admin")
                    .run_command(doc! { "killOp": 1, "op": opid })
                    .await
                    .context("MongoDB killOp failed")?;
                Ok(true)
            }
        }
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
        // Honour the caller's page size: clamping to the interactive row cap
        // here silently truncated paged fetches (exports page in 1000-row
        // batches). limit=0 keeps the interactive default.
        let page_limit = if limit > 0 {
            limit.min(i64::MAX as u64)
        } else {
            MAX_QUERY_RESULT_ROWS as u64
        };
        let mut action = collection
            .find(filter_document)
            .skip(offset)
            .limit(page_limit as i64);
        if let Some(sort_document) = Self::build_sort_document(order_by, order_dir) {
            action = action.sort(sort_document);
        }
        let mut cursor = action.await?;
        let mut documents = Vec::new();
        let mut truncated = false;
        while let Some(document) = cursor.try_next().await? {
            if documents.len() as u64 == page_limit {
                truncated = true;
                break;
            }
            documents.push(document);
        }
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

    /// Applies the edit queue inside one multi-document transaction so a
    /// stale row selector or a mid-queue failure aborts everything instead of
    /// leaving a partially committed batch. Requires a replica set or mongos;
    /// standalone deployments are rejected by `begin_transaction`.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        if updates.is_empty() {
            return Ok(0);
        }
        let mut session = self.begin_transaction().await?;
        let execution = async {
            let mut affected_rows = 0u64;
            for request in updates {
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
                    .session(&mut session)
                    .await
                    .with_context(|| {
                        format!("Failed to update MongoDB collection {}", request.table)
                    })?;
                // A selector that matches nothing means the row changed since
                // the edit was queued; abort the whole queue like Postgres.
                if result.matched_count == 0 {
                    return Err(anyhow!(
                        "An edit queue row no longer matches its primary-key selector"
                    ));
                }
                affected_rows += result.matched_count;
            }
            Ok::<_, anyhow::Error>(affected_rows)
        }
        .await;
        match execution {
            Ok(affected_rows) => {
                Self::commit_transaction(&mut session).await?;
                Ok(affected_rows)
            }
            Err(error) => {
                Self::abort_transaction_quietly(&mut session).await;
                Err(error)
            }
        }
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

    /// Imports the buffered rows inside one transaction: rows are grouped by
    /// their target collection and written with `insert_many` batches so the
    /// cancel flag is honoured between batches. Any failure or cancellation
    /// aborts the transaction — no partial import survives.
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }
        let mut session = self.begin_transaction().await?;
        let execution = async {
            // Group by resolved (database, collection) so one transaction can
            // span several collections while each batch stays a single
            // insert_many.
            let mut batches: BTreeMap<(String, String), (Collection<Document>, Vec<Document>)> =
                BTreeMap::new();
            for request in requests {
                if request.values.is_empty() {
                    return Err(anyhow!("Each CSV row requires at least one column value"));
                }
                let db_name = self.database_name(request.database.as_deref()).await;
                let collection_name =
                    strip_database_prefix(request.table.trim(), &db_name).to_string();
                if collection_name.is_empty() {
                    return Err(anyhow!("MongoDB collection name cannot be empty"));
                }
                let mut document = Document::new();
                for (key, value) in &request.values {
                    document.insert(key.clone(), Self::json_value_to_bson(value.clone())?);
                }
                let entry = batches
                    .entry((db_name.clone(), collection_name.clone()))
                    .or_insert_with(|| {
                        (
                            self.client
                                .database(&db_name)
                                .collection::<Document>(&collection_name),
                            Vec::new(),
                        )
                    });
                entry.1.push(document);
            }
            let mut affected_rows = 0u64;
            for (collection, documents) in batches.values() {
                for chunk in documents.chunks(MONGO_TXN_INSERT_BATCH) {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
                    }
                    affected_rows +=
                        Self::insert_document_batch(collection, chunk.to_vec(), &mut session)
                            .await?;
                }
            }
            Ok::<_, anyhow::Error>(affected_rows)
        }
        .await;
        match execution {
            Ok(affected_rows) => {
                Self::commit_transaction(&mut session).await?;
                Ok(affected_rows)
            }
            Err(error) => {
                Self::abort_transaction_quietly(&mut session).await;
                Err(error)
            }
        }
    }

    /// Streams CSV rows into the same transaction shape as the buffered
    /// import: parse failures, cancellation, and empty streams abort, so the
    /// file either lands completely or not at all.
    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        let mut session = self.begin_transaction().await?;
        let execution = async {
            let mut pending: BTreeMap<(String, String), (Collection<Document>, Vec<Document>)> =
                BTreeMap::new();
            let mut affected_rows = 0u64;
            while let Some(request) = rows.recv().await {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
                }
                let request = request.map_err(anyhow::Error::msg)?;
                if request.values.is_empty() {
                    return Err(anyhow!("Each CSV row requires at least one column value"));
                }
                let db_name = self.database_name(request.database.as_deref()).await;
                let collection_name =
                    strip_database_prefix(request.table.trim(), &db_name).to_string();
                if collection_name.is_empty() {
                    return Err(anyhow!("MongoDB collection name cannot be empty"));
                }
                let mut document = Document::new();
                for (key, value) in &request.values {
                    document.insert(key.clone(), Self::json_value_to_bson(value.clone())?);
                }
                let entry = pending
                    .entry((db_name.clone(), collection_name.clone()))
                    .or_insert_with(|| {
                        (
                            self.client
                                .database(&db_name)
                                .collection::<Document>(&collection_name),
                            Vec::new(),
                        )
                    });
                entry.1.push(document);
                if entry.1.len() >= MONGO_TXN_INSERT_BATCH {
                    let collection = entry.0.clone();
                    let batch = std::mem::take(&mut entry.1);
                    affected_rows +=
                        Self::insert_document_batch(&collection, batch, &mut session).await?;
                }
            }
            for (collection, batch) in pending.values_mut() {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
                }
                affected_rows +=
                    Self::insert_document_batch(collection, std::mem::take(batch), &mut session)
                        .await?;
            }
            if affected_rows == 0 {
                return Err(anyhow!("CSV import did not contain any data rows"));
            }
            Ok::<_, anyhow::Error>(affected_rows)
        }
        .await;
        match execution {
            Ok(affected_rows) => {
                Self::commit_transaction(&mut session).await?;
                Ok(affected_rows)
            }
            Err(error) => {
                Self::abort_transaction_quietly(&mut session).await;
                Err(error)
            }
        }
    }

    /// Runs the reviewed statements inside one transaction and ALWAYS aborts
    /// it, returning the per-statement results as a preview. Reads and writes
    /// both pin to the session so the preview observes its own uncommitted
    /// writes exactly like a real execution would.
    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        let mut session = self.begin_transaction().await?;
        let execution = async {
            let mut results = Vec::with_capacity(statements.len());
            for statement in statements {
                let mut result = self
                    .execute_command(statement, None, Some(&mut session))
                    .await?;
                result.sandboxed = true;
                results.push(result);
            }
            Ok::<_, anyhow::Error>(results)
        }
        .await;
        Self::abort_transaction_quietly(&mut session).await;
        execution
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
