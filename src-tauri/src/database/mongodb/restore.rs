use super::driver_ops::MONGO_TXN_INSERT_BATCH;
use super::{strip_database_prefix, MongoDbDriver};
use anyhow::{anyhow, Context, Result};
use mongodb::bson::{Bson, Document};
use mongodb::{ClientSession, Collection};
use serde_json::Value as JsonValue;

/// One parsed snapshot table entry: the validated collection reference plus
/// the BSON documents built from its rows. Kept free of driver handles so the
/// snapshot→command mapping stays unit-testable.
#[derive(Debug)]
pub(super) struct SnapshotTable {
    /// Database override from the snapshot (`schema`, or `database` for
    /// robustness against hand-written snapshots); `None` restores into the
    /// connection's current database.
    schema: Option<String>,
    /// The collection name exactly as it appears in the snapshot.
    name: String,
    /// Documents built from the snapshot rows — never interpolated text.
    documents: Vec<Document>,
}

/// Classifies a restore payload the way the Redis driver does: a TableR
/// JSON snapshot parses into replay plans (`Some`), anything else returns
/// `None` so the caller keeps the default statement path. Payloads that
/// look like a snapshot but are not (`meta.format` mismatch, missing
/// `tables`, malformed rows) are hard errors — guessing SQL around a
/// half-valid snapshot would corrupt data.
pub(super) fn snapshot_restore_tables(statements: &[String]) -> Result<Option<Vec<SnapshotTable>>> {
    // `split_sql_statements` keeps a JSON document inside one statement, but
    // join for robustness — a pretty-printed snapshot with semicolons inside
    // string values is handled there anyway, and hand-edited payloads may
    // not be.
    let joined = statements.join(";\n");
    let trimmed = joined.trim();
    if !trimmed.starts_with('{') {
        return Ok(None);
    }
    let snapshot: JsonValue = serde_json::from_str(trimmed).with_context(|| {
        "The restore payload looks like a JSON snapshot but could not be parsed"
    })?;
    let format = snapshot
        .get("meta")
        .and_then(|meta| meta.get("format"))
        .and_then(JsonValue::as_str);
    if format != Some("json-snapshot") {
        return Err(anyhow!(
            "The restore payload is JSON but not a TableR json-snapshot export"
        ));
    }
    let tables = snapshot
        .get("tables")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| anyhow!("The JSON snapshot does not contain a 'tables' array"))?;
    if tables.is_empty() {
        return Err(anyhow!(
            "The JSON snapshot does not contain any collections"
        ));
    }

    let mut plans = Vec::with_capacity(tables.len());
    for table in tables {
        let name = table
            .get("name")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| anyhow!("A snapshot table entry is missing its collection name"))?;
        validate_collection_name(name)?;
        let schema = table
            .get("schema")
            .or_else(|| table.get("database"))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let column_names = snapshot_column_names(table);
        let rows = table
            .get("rows")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| anyhow!("Snapshot collection '{name}' is missing its 'rows' array"))?;
        let mut documents = Vec::with_capacity(rows.len());
        for row in rows {
            documents.push(snapshot_row_to_document(name, row, &column_names)?);
        }
        plans.push(SnapshotTable {
            schema,
            name: name.to_string(),
            documents,
        });
    }
    Ok(Some(plans))
}

/// Column names for array-shaped rows: the exported `structure.columns`
/// (ColumnDetail serializes snake_case) first, then a flat `columns` array
/// for snapshots written by other producers.
fn snapshot_column_names(table: &JsonValue) -> Vec<String> {
    let from_structure = table
        .get("structure")
        .and_then(|structure| structure.get("columns"))
        .and_then(JsonValue::as_array)
        .map(|columns| {
            columns
                .iter()
                .filter_map(|column| {
                    column
                        .get("name")
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
        });
    if let Some(names) = from_structure.filter(|names| !names.is_empty()) {
        return names;
    }
    table
        .get("columns")
        .and_then(JsonValue::as_array)
        .map(|columns| {
            columns
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// Turns one snapshot row into a BSON document. Object rows map keys to
/// fields verbatim (the shape `stream_json_snapshot` writes); array rows
/// align cells with the exported column list.
fn snapshot_row_to_document(
    name: &str,
    row: &JsonValue,
    column_names: &[String],
) -> Result<Document> {
    match row {
        JsonValue::Object(map) => {
            let mut document = Document::new();
            for (key, value) in map {
                document.insert(key.clone(), snapshot_value_to_bson(value)?);
            }
            Ok(document)
        }
        JsonValue::Array(cells) => {
            if column_names.is_empty() {
                return Err(anyhow!(
                    "Snapshot collection '{name}' has array-shaped rows but no column list"
                ));
            }
            let mut document = Document::new();
            for (index, cell) in cells.iter().enumerate() {
                let key = column_names.get(index).ok_or_else(|| {
                    anyhow!(
                        "Snapshot row for '{name}' has more cells than the exported column list"
                    )
                })?;
                document.insert(key.clone(), snapshot_value_to_bson(cell)?);
            }
            Ok(document)
        }
        _ => Err(anyhow!("Snapshot row for '{name}' is not a JSON object")),
    }
}

/// Rebuilds a BSON value from a snapshot cell. Nested documents/arrays are
/// exported as JSON *strings* (`bson_to_grid_cell`), so a string that parses
/// as an object/array is expanded back — otherwise the restore would persist
/// the stringified form and silently change the document's type.
fn snapshot_value_to_bson(value: &JsonValue) -> Result<Bson> {
    if let JsonValue::String(raw) = value {
        let trimmed = raw.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(parsed) = serde_json::from_str::<JsonValue>(trimmed) {
                return MongoDbDriver::json_value_to_bson(parsed);
            }
        }
    }
    MongoDbDriver::json_value_to_bson(value.clone())
}

/// Names land in collection handles, never SQL text, so there is no
/// injection surface — this validation exists to reject malformed snapshot
/// data and names the server rejects (`$`, NUL bytes, reserved `system.`
/// collections) with a clear error before any write happens.
fn validate_collection_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("A snapshot collection name cannot be empty"));
    }
    if trimmed.starts_with("system.") {
        return Err(anyhow!(
            "Snapshot collection '{trimmed}' targets a reserved system namespace"
        ));
    }
    if trimmed.chars().any(|ch| ch == '$' || ch == '\0') {
        return Err(anyhow!(
            "Snapshot collection '{trimmed}' contains characters MongoDB rejects"
        ));
    }
    Ok(())
}

impl MongoDbDriver {
    /// Applies one parsed collection: wipe the target with
    /// `delete_many({})`, then insert the snapshot documents in bounded
    /// batches. Values reach the server only as BSON documents bound into
    /// the driver's wire ops.
    async fn restore_snapshot_collection(
        collection: &Collection<Document>,
        documents: &[Document],
        mut session: Option<&mut ClientSession>,
    ) -> Result<u64> {
        let collection_name = collection.name();
        let mut affected = match session.as_deref_mut() {
            Some(session) => {
                collection
                    .delete_many(Document::new())
                    .session(&mut *session)
                    .await
            }
            None => collection.delete_many(Document::new()).await,
        }
        .with_context(|| {
            format!("Failed to clear MongoDB collection {collection_name} for restore")
        })?
        .deleted_count;
        for chunk in documents.chunks(MONGO_TXN_INSERT_BATCH) {
            let result = match session.as_deref_mut() {
                Some(session) => {
                    collection
                        .insert_many(chunk.to_vec())
                        .session(&mut *session)
                        .await
                }
                None => collection.insert_many(chunk.to_vec()).await,
            }
            .with_context(|| {
                format!("Failed to restore documents into MongoDB collection {collection_name}")
            })?;
            affected += result.inserted_ids.len() as u64;
        }
        Ok(affected)
    }

    /// `delete_many` inside a transaction fails with NamespaceNotFound when
    /// the collection does not exist, and implicit creation inside a
    /// transaction only works on server 4.4+ — creating the missing
    /// collections up front keeps the replay version-agnostic and also
    /// lands empty snapshot collections consistently on both paths.
    /// NamespaceExists (48) races are benign: another writer created the
    /// collection between our check and create.
    async fn ensure_snapshot_collections(&self, tables: &[SnapshotTable]) -> Result<()> {
        for table in tables {
            let db_name = self.database_name(table.schema.as_deref()).await;
            let collection_name = strip_database_prefix(table.name.trim(), &db_name);
            let database = self.client.database(&db_name);
            let exists = database
                .list_collection_names()
                .await
                .with_context(|| {
                    format!("Failed to list MongoDB collections for restore on {db_name}")
                })?
                .iter()
                .any(|existing| existing == collection_name);
            if exists {
                continue;
            }
            match database.create_collection(collection_name).await {
                Ok(_) => {}
                Err(error) if is_namespace_exists(&error) => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "Failed to create MongoDB collection {db_name}.{collection_name} for restore"
                        )
                    })
                }
            }
        }
        Ok(())
    }

    /// Replays a parsed TableR JSON snapshot: every collection is cleared
    /// and rebuilt from its snapshot documents inside one multi-document
    /// transaction when the deployment supports it (the shared `hello`
    /// probe decides). Standalone deployments get the same delete+insert
    /// sequence outside a transaction — a mid-restore failure there leaves
    /// earlier collections applied, which is logged so the caveat is never
    /// silent.
    pub(super) async fn replay_snapshot_tables(&self, tables: Vec<SnapshotTable>) -> Result<u64> {
        let transactional = self.transactions_supported().await?;
        self.ensure_snapshot_collections(&tables).await?;

        let mut entries = Vec::with_capacity(tables.len());
        for table in &tables {
            let collection = self
                .collection_handle(&table.name, table.schema.as_deref())
                .await?;
            entries.push((collection, table.documents.as_slice()));
        }

        if !transactional {
            log::warn!(
                "MongoDB snapshot restore is running without a transaction (standalone \
                 deployment): a mid-restore failure leaves earlier collections applied."
            );
            let mut affected = 0_u64;
            for (collection, documents) in &entries {
                affected += Self::restore_snapshot_collection(collection, documents, None).await?;
            }
            return Ok(affected);
        }

        let mut session = self.begin_transaction().await?;
        let execution = async {
            let mut affected = 0_u64;
            for (collection, documents) in &entries {
                affected +=
                    Self::restore_snapshot_collection(collection, documents, Some(&mut session))
                        .await?;
            }
            Ok::<_, anyhow::Error>(affected)
        }
        .await;
        match execution {
            Ok(affected) => {
                Self::commit_transaction(&mut session).await?;
                Ok(affected)
            }
            Err(error) => {
                Self::abort_transaction_quietly(&mut session).await;
                Err(error)
            }
        }
    }
}

/// True for the server's "collection already exists" rejection — treated as
/// success because another writer simply beat us to the create.
fn is_namespace_exists(error: &mongodb::error::Error) -> bool {
    matches!(
        error.kind.as_ref(),
        mongodb::error::ErrorKind::Command(command)
            if command.code == 48 || command.code_name == "NamespaceExists"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(tables: JsonValue) -> String {
        json!({
            "meta": {
                "format": "json-snapshot",
                "engine": "MongoDB",
                "database": "app",
                "exportedAt": "2026-09-25T00:00:00Z"
            },
            "schemaObjects": [],
            "tables": tables
        })
        .to_string()
    }

    fn plan(payload: &str) -> Result<Vec<SnapshotTable>> {
        match snapshot_restore_tables(&[payload.to_string()])? {
            Some(tables) => Ok(tables),
            None => Err(anyhow!("expected a snapshot plan")),
        }
    }

    #[test]
    fn non_json_payload_falls_through_to_statements() {
        assert!(snapshot_restore_tables(&["db.users.find()".to_string()])
            .unwrap()
            .is_none());
        assert!(snapshot_restore_tables(&["  -- comment\n".to_string()])
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_json_that_is_not_a_snapshot() {
        let error = plan(&json!({"meta": {"format": "csv-dump"}}).to_string()).unwrap_err();
        assert!(error.to_string().contains("json-snapshot"));
    }

    #[test]
    fn rejects_malformed_json_payload() {
        let error = plan("{ \"meta\": ").unwrap_err();
        assert!(error.to_string().contains("could not be parsed"));
    }

    #[test]
    fn rejects_snapshot_without_tables() {
        let error = plan(&snapshot(json!({"name": "users"}))).unwrap_err();
        assert!(error.to_string().contains("'tables' array"));
    }

    #[test]
    fn parses_object_rows_into_documents() {
        let payload = snapshot(json!([
            {
                "name": "users",
                "schema": "app",
                "tableType": "collection",
                "structure": {
                    "columns": [
                        {"name": "_id", "data_type": "objectId"},
                        {"name": "name", "data_type": "string"}
                    ],
                    "indexes": [],
                    "foreign_keys": [],
                    "triggers": [],
                    "view_definition": null,
                    "object_type": "collection"
                },
                "rows": [
                    {"_id": "66c2d0f0a13b5f9aabbccdde", "name": "ada", "age": 36, "tag": null},
                    {"_id": "66c2d0f0a13b5f9aabbccddf", "name": "grace"}
                ]
            }
        ]));
        let tables = plan(&payload).unwrap();
        assert_eq!(tables.len(), 1);
        let table = &tables[0];
        assert_eq!(table.name, "users");
        assert_eq!(table.schema.as_deref(), Some("app"));
        assert_eq!(table.documents.len(), 2);
        assert!(matches!(
            table.documents[0].get("_id"),
            Some(Bson::ObjectId(_))
        ));
        assert_eq!(
            table.documents[0].get("name"),
            Some(&Bson::String("ada".to_string()))
        );
        assert_eq!(table.documents[0].get("age"), Some(&Bson::Int64(36)));
        assert_eq!(table.documents[0].get("tag"), Some(&Bson::Null));
    }

    #[test]
    fn expands_exported_json_strings_back_into_documents() {
        // `bson_to_grid_cell` stringifies nested documents/arrays on export;
        // the restore must turn them back or the document's type changes.
        let payload = snapshot(json!([
            {
                "name": "orders",
                "rows": [
                    {"_id": "o1", "address": "{\"city\": \"Hanoi\"}", "items": "[1, 2]", "note": "{broken"}
                ]
            }
        ]));
        let tables = plan(&payload).unwrap();
        let document = &tables[0].documents[0];
        assert!(matches!(document.get("address"), Some(Bson::Document(_))));
        assert_eq!(
            document.get("items"),
            Some(&Bson::Array(vec![Bson::Int64(1), Bson::Int64(2)]))
        );
        // A string that merely starts with a brace but is not JSON stays a
        // string.
        assert_eq!(
            document.get("note"),
            Some(&Bson::String("{broken".to_string()))
        );
    }

    #[test]
    fn maps_array_rows_with_structure_columns() {
        let payload = snapshot(json!([
            {
                "name": "events",
                "structure": {
                    "columns": [
                        {"name": "_id", "data_type": "string"},
                        {"name": "kind", "data_type": "string"}
                    ],
                    "indexes": [],
                    "foreign_keys": [],
                    "triggers": [],
                    "view_definition": null,
                    "object_type": "collection"
                },
                "rows": [["a1", "login"]]
            }
        ]));
        let tables = plan(&payload).unwrap();
        let document = &tables[0].documents[0];
        assert_eq!(document.get("_id"), Some(&Bson::String("a1".to_string())));
        assert_eq!(
            document.get("kind"),
            Some(&Bson::String("login".to_string()))
        );
    }

    #[test]
    fn rejects_array_rows_without_columns_and_scalars() {
        let no_columns = snapshot(json!([{ "name": "t", "rows": [[1, 2]] }]));
        assert!(plan(&no_columns)
            .unwrap_err()
            .to_string()
            .contains("column list"));
        let scalar = snapshot(json!([{ "name": "t", "rows": [42] }]));
        assert!(plan(&scalar)
            .unwrap_err()
            .to_string()
            .contains("not a JSON object"));
    }

    #[test]
    fn rejects_reserved_and_invalid_collection_names() {
        for name in ["", "  ", "system.users", "a$b", "bad\0name"] {
            let payload = snapshot(json!([{ "name": name, "rows": [] }]));
            assert!(plan(&payload).is_err(), "expected '{name}' to be rejected");
        }
        // Dots in regular names are valid collection names.
        let payload = snapshot(json!([{ "name": "metrics.daily", "rows": [] }]));
        assert!(plan(&payload).is_ok());
    }

    #[test]
    fn rejects_snapshot_missing_rows() {
        let payload = snapshot(json!([{ "name": "users" }]));
        assert!(plan(&payload).unwrap_err().to_string().contains("'rows'"));
    }

    #[test]
    fn rejects_empty_tables_array() {
        let payload = snapshot(json!([]));
        assert!(plan(&payload)
            .unwrap_err()
            .to_string()
            .contains("does not contain any collections"));
    }
}
