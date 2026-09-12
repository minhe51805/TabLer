//! Wire protocol for the `driver-sidecar-v1` native-driver IPC contract.
//!
//! Phase 4 runs each `plugin_native` engine (DuckDB, Cassandra, Redis, LibSQL)
//! as an out-of-process sidecar the host talks to over a stable, versioned
//! protocol instead of linking the wire-protocol crate. Rust has no stable ABI,
//! so a compiled "native driver" cannot be loaded into the app process; a
//! sidecar sidesteps that by being a standalone per-platform binary.
//!
//! This module defines ONLY the contract (the messages and their framing). The
//! host-side proxy that spawns the process and speaks this protocol, plus the
//! reference sidecar binary, are layered on top in later sub-phases.
//!
//! Design mirrors the `DatabaseDriver` trait one-to-one so the host proxy can
//! forward every trait method. Every payload reuses the existing serde models,
//! so the sidecar and host share exactly one definition of the data shapes.

use crate::database::models::*;
use serde::{Deserialize, Serialize};

/// Version string a host and a sidecar must agree on during the handshake.
/// Bump this (and add a negotiation policy) on any breaking wire change.
pub const SIDECAR_PROTOCOL_VERSION: &str = "driver-sidecar-v1";

/// A single request from host -> sidecar. `id` correlates the matching
/// [`SidecarResponse`]; it is monotonically increasing per connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarRequest {
    pub id: u64,
    pub call: SidecarCall,
}

/// Every unary `DatabaseDriver` method, mirrored exactly. Adjacently tagged so
/// a unit call serializes as `{"op":"ping"}` and a call with arguments as
/// `{"op":"execute_query","args":{"sql":"..."}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", content = "args", rename_all = "snake_case")]
pub enum SidecarCall {
    /// First call on a fresh process: agree on the protocol version.
    Handshake { protocol_version: String },
    /// Open the underlying connection. Boxed to keep the enum small.
    Connect { config: Box<ConnectionConfig> },
    Ping,
    Disconnect,
    ListDatabases,
    ListTables {
        database: Option<String>,
    },
    ListSchemaObjects {
        database: Option<String>,
    },
    GetTableStructure {
        table: String,
        database: Option<String>,
    },
    GetTableColumnsPreview {
        table: String,
        database: Option<String>,
    },
    ExecuteQuery {
        sql: String,
    },
    ExecuteQueryForRequest {
        request_id: String,
        sql: String,
    },
    CancelQueryRequest {
        request_id: String,
    },
    ExecuteParameterizedQuery {
        sql: String,
        parameters: Vec<QueryParameter>,
    },
    ExecuteParameterizedQueryForRequest {
        request_id: String,
        sql: String,
        parameters: Vec<QueryParameter>,
    },
    GetTableData {
        table: String,
        database: Option<String>,
        offset: u64,
        limit: u64,
        order_by: Option<String>,
        order_dir: Option<String>,
        filter: Option<String>,
    },
    CountRows {
        table: String,
        database: Option<String>,
    },
    CountNullValues {
        table: String,
        database: Option<String>,
        column: String,
    },
    UpdateTableCell {
        request: TableCellUpdateRequest,
    },
    ApplyTableUpdatesAtomically {
        updates: Vec<TableCellUpdateRequest>,
    },
    DeleteTableRows {
        request: TableRowDeleteRequest,
    },
    InsertTableRow {
        request: TableRowInsertRequest,
    },
    /// Atomic bulk insert. The host may abort it in flight with a
    /// [`HostFrame::Cancel`] carrying this request's `id`.
    InsertTableRowsAtomically {
        requests: Vec<TableRowInsertRequest>,
    },
    /// Begin a streamed atomic import. Rows arrive as follow-up
    /// [`HostFrame::StreamChunk`] frames, terminated by
    /// [`HostFrame::StreamEnd`]; cancellation uses [`HostFrame::Cancel`].
    InsertTableRowStreamAtomically,
    ExecuteStructureStatements {
        statements: Vec<String>,
    },
    PreviewWriteTransaction {
        statements: Vec<String>,
    },
    ExecuteRestoreStatements {
        statements: Vec<String>,
    },
    UseDatabase {
        database: String,
    },
    GetForeignKeyLookupValues {
        referenced_table: String,
        referenced_column: String,
        display_columns: Vec<String>,
        search: Option<String>,
        limit: u32,
    },
    CurrentDatabase,
    DriverName,
}

/// A single response from sidecar -> host, correlated by `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarResponse {
    pub id: u64,
    pub outcome: SidecarOutcome,
}

/// Success carries a typed payload; failure carries a structured error the host
/// converts back into an `anyhow::Error` for the `DatabaseDriver` surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum SidecarOutcome {
    Ok(SidecarResponsePayload),
    Err(SidecarError),
}

/// Typed result payloads, one per distinct `DatabaseDriver` return type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum SidecarResponsePayload {
    /// Reply to [`SidecarCall::Handshake`].
    Handshake {
        protocol_version: String,
        driver_name: String,
    },
    /// Reply to methods returning `()` (ping, disconnect, use_database).
    Unit,
    Databases(Vec<DatabaseInfo>),
    Tables(Vec<TableInfo>),
    SchemaObjects(Vec<SchemaObjectInfo>),
    TableStructure(TableStructure),
    Columns(Vec<ColumnDetail>),
    Query(QueryResult),
    Queries(Vec<QueryResult>),
    /// Signed count (count_rows, count_null_values).
    Count(i64),
    /// Affected/returned row count (updates, inserts, structure statements).
    Affected(u64),
    /// Reply to cancel_query_request.
    Cancelled(bool),
    LookupValues(Vec<LookupValue>),
    CurrentDatabase(Option<String>),
    DriverName(String),
}

/// Structured error so the host can preserve messaging and, later, retry/kind
/// classification across the process boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarError {
    pub message: String,
    /// Coarse classification; `Unknown` when the sidecar cannot be specific.
    #[serde(default)]
    pub kind: SidecarErrorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SidecarErrorKind {
    /// The sidecar could not open or lost the underlying connection.
    Connection,
    /// The engine rejected the statement/operation.
    Query,
    /// The operation was cancelled by the host.
    Cancelled,
    /// The call is not supported by this driver (mirrors the trait defaults).
    Unsupported,
    /// The host sent a malformed or out-of-sequence frame.
    Protocol,
    #[default]
    Unknown,
}

/// Everything the host can send. `Request` drives a unary call; the other
/// frames are out-of-band controls that reference an in-flight request `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostFrame {
    Request(SidecarRequest),
    /// Abort the in-flight operation for `id` (bulk/stream inserts, and the
    /// cooperative cancellation flag the trait passes as `Arc<AtomicBool>`).
    Cancel { id: u64 },
    /// A batch of rows for an in-flight `InsertTableRowStreamAtomically`.
    StreamChunk { id: u64, rows: Vec<CsvImportRow> },
    /// End-of-stream marker for `InsertTableRowStreamAtomically`.
    StreamEnd { id: u64 },
    /// Ask the sidecar to exit cleanly.
    Shutdown,
}

/// Everything the sidecar can send back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarFrame {
    Response(SidecarResponse),
    /// Free-form diagnostic surfaced to the host log, never to the UI.
    Log { level: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Encoding then decoding then re-encoding must be lossless. Comparing the
    /// two JSON `Value`s (not strings) ignores key ordering while still pinning
    /// the exact shape — the guarantee the host and sidecar both rely on.
    fn assert_round_trips<T>(value: &T)
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(value).expect("serialize");
        assert!(
            !json.contains('\n'),
            "framed messages must be single-line JSON, got: {json}"
        );
        let decoded: T = serde_json::from_str(&json).expect("deserialize");
        let reencoded = serde_json::to_string(&decoded).expect("re-serialize");
        assert_eq!(
            serde_json::from_str::<Value>(&json).unwrap(),
            serde_json::from_str::<Value>(&reencoded).unwrap(),
        );
    }

    #[test]
    fn protocol_version_is_the_reserved_runtime_id() {
        // Must match the `driver-sidecar-v1` runtime reserved in the taxonomy
        // doc and (Phase 4d) recognized as a plugin runtime.
        assert_eq!(SIDECAR_PROTOCOL_VERSION, "driver-sidecar-v1");
    }

    #[test]
    fn unit_call_serializes_without_an_args_key() {
        let json = serde_json::to_string(&SidecarCall::Ping).unwrap();
        assert_eq!(json, r#"{"op":"ping"}"#);
    }

    #[test]
    fn call_with_args_uses_snake_case_op_and_args() {
        let json = serde_json::to_string(&SidecarCall::ListTables {
            database: Some("shop".into()),
        })
        .unwrap();
        assert_eq!(json, r#"{"op":"list_tables","args":{"database":"shop"}}"#);
    }

    #[test]
    fn error_kind_defaults_to_unknown_when_absent() {
        let err: SidecarError = serde_json::from_str(r#"{"message":"boom"}"#).unwrap();
        assert_eq!(err.kind, SidecarErrorKind::Unknown);
    }

    #[test]
    fn every_call_variant_round_trips() {
        let calls = vec![
            SidecarCall::Handshake {
                protocol_version: SIDECAR_PROTOCOL_VERSION.into(),
            },
            SidecarCall::Ping,
            SidecarCall::Disconnect,
            SidecarCall::ListDatabases,
            SidecarCall::ListTables { database: None },
            SidecarCall::ListSchemaObjects {
                database: Some("db".into()),
            },
            SidecarCall::GetTableStructure {
                table: "t".into(),
                database: None,
            },
            SidecarCall::GetTableColumnsPreview {
                table: "t".into(),
                database: Some("db".into()),
            },
            SidecarCall::ExecuteQuery {
                sql: "SELECT 1".into(),
            },
            SidecarCall::ExecuteQueryForRequest {
                request_id: "r1".into(),
                sql: "SELECT 1".into(),
            },
            SidecarCall::CancelQueryRequest {
                request_id: "r1".into(),
            },
            SidecarCall::ExecuteParameterizedQuery {
                sql: "SELECT $1".into(),
                parameters: vec![],
            },
            SidecarCall::ExecuteParameterizedQueryForRequest {
                request_id: "r1".into(),
                sql: "SELECT $1".into(),
                parameters: vec![],
            },
            SidecarCall::GetTableData {
                table: "t".into(),
                database: None,
                offset: 0,
                limit: 100,
                order_by: Some("id".into()),
                order_dir: Some("asc".into()),
                filter: None,
            },
            SidecarCall::CountRows {
                table: "t".into(),
                database: None,
            },
            SidecarCall::CountNullValues {
                table: "t".into(),
                database: None,
                column: "c".into(),
            },
            SidecarCall::ApplyTableUpdatesAtomically { updates: vec![] },
            SidecarCall::InsertTableRowsAtomically { requests: vec![] },
            SidecarCall::InsertTableRowStreamAtomically,
            SidecarCall::ExecuteStructureStatements { statements: vec![] },
            SidecarCall::PreviewWriteTransaction { statements: vec![] },
            SidecarCall::ExecuteRestoreStatements { statements: vec![] },
            SidecarCall::UseDatabase {
                database: "db".into(),
            },
            SidecarCall::GetForeignKeyLookupValues {
                referenced_table: "t".into(),
                referenced_column: "id".into(),
                display_columns: vec!["name".into()],
                search: Some("a".into()),
                limit: 25,
            },
            SidecarCall::CurrentDatabase,
            SidecarCall::DriverName,
        ];
        for call in &calls {
            assert_round_trips(call);
        }
    }

    #[test]
    fn responses_and_errors_round_trip() {
        assert_round_trips(&SidecarResponse {
            id: 7,
            outcome: SidecarOutcome::Ok(SidecarResponsePayload::Handshake {
                protocol_version: SIDECAR_PROTOCOL_VERSION.into(),
                driver_name: "duckdb".into(),
            }),
        });
        assert_round_trips(&SidecarResponse {
            id: 8,
            outcome: SidecarOutcome::Ok(SidecarResponsePayload::Unit),
        });
        assert_round_trips(&SidecarResponse {
            id: 9,
            outcome: SidecarOutcome::Ok(SidecarResponsePayload::Count(-1)),
        });
        assert_round_trips(&SidecarResponse {
            id: 10,
            outcome: SidecarOutcome::Ok(SidecarResponsePayload::Affected(42)),
        });
        assert_round_trips(&SidecarResponse {
            id: 11,
            outcome: SidecarOutcome::Ok(SidecarResponsePayload::CurrentDatabase(None)),
        });
        assert_round_trips(&SidecarResponse {
            id: 12,
            outcome: SidecarOutcome::Err(SidecarError {
                message: "connection refused".into(),
                kind: SidecarErrorKind::Connection,
            }),
        });
    }

    #[test]
    fn host_and_sidecar_frames_round_trip() {
        assert_round_trips(&HostFrame::Request(SidecarRequest {
            id: 1,
            call: SidecarCall::Ping,
        }));
        assert_round_trips(&HostFrame::Cancel { id: 1 });
        assert_round_trips(&HostFrame::StreamChunk {
            id: 1,
            rows: vec![Err("bad row".to_string())],
        });
        assert_round_trips(&HostFrame::StreamEnd { id: 1 });
        assert_round_trips(&HostFrame::Shutdown);
        assert_round_trips(&SidecarFrame::Log {
            level: "warn".into(),
            message: "slow query".into(),
        });
    }
}
