use super::models::DatabaseType;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverTier {
    Core,
    Extended,
    Specialized,
}

/// How the engine is packaged and shipped (plugin-split taxonomy).
///
/// `Builtin` drivers are compiled into TableR and always connectable. `PluginHttp`
/// engines speak HTTP/REST and are the candidates to move behind installable
/// plugin manifests (like OpenSearch today) so they can ship out-of-band without
/// a rebuild. `PluginNative` engines use a compiled wire-protocol crate and can
/// only be externalized through a feature-flag build or an out-of-process
/// sidecar — never a downloaded declarative manifest, because Rust has no stable
/// ABI for loading compiled drivers at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverDistribution {
    Builtin,
    PluginHttp,
    PluginNative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySupport {
    Supported,
    Limited,
    Unsupported,
    NotApplicable,
}

/// How the agent should talk to this engine. SQL-shaped tools
/// (`run_readonly_sql`, `preview_write`) apply to `Sql`, CQL SELECT, and
/// MongoDB's translated SELECT subset; write previews additionally require a
/// driver `preview_write_transaction` impl (see
/// [`agent_allows_sql_write_preview`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryModel {
    Sql,
    Cql,
    Document,
    Kv,
    Search,
}

pub const fn query_model_for(database_type: DatabaseType) -> QueryModel {
    match database_type {
        DatabaseType::Redis => QueryModel::Kv,
        DatabaseType::MongoDB => QueryModel::Document,
        DatabaseType::OpenSearch | DatabaseType::Elasticsearch => QueryModel::Search,
        DatabaseType::Cassandra => QueryModel::Cql,
        _ => QueryModel::Sql,
    }
}

/// Packaging tier for each engine (plugin-split). The built-in set is the five
/// wire drivers the product always ships — MySQL, PostgreSQL, SQLite, SQL Server,
/// MongoDB — plus every engine that reuses one of those compiled drivers
/// (MariaDB → MySQL wire; CockroachDB/Greenplum/Redshift/Vertica → PostgreSQL
/// wire). HTTP engines are `PluginHttp`; compiled-crate engines are
/// `PluginNative`. The match is exhaustive on purpose: adding a new engine forces
/// a packaging decision here.
pub const fn driver_distribution(database_type: DatabaseType) -> DriverDistribution {
    match database_type {
        DatabaseType::MySQL
        | DatabaseType::MariaDB
        | DatabaseType::PostgreSQL
        | DatabaseType::CockroachDB
        | DatabaseType::Greenplum
        | DatabaseType::Redshift
        | DatabaseType::Vertica
        | DatabaseType::SQLite
        | DatabaseType::MSSQL
        | DatabaseType::MongoDB => DriverDistribution::Builtin,
        DatabaseType::ClickHouse
        | DatabaseType::BigQuery
        | DatabaseType::Snowflake
        | DatabaseType::CloudflareD1
        | DatabaseType::OpenSearch
        | DatabaseType::Elasticsearch
        | DatabaseType::Oracle
        | DatabaseType::Spanner
        | DatabaseType::DynamoDB
        | DatabaseType::Trino => DriverDistribution::PluginHttp,
        DatabaseType::DuckDB
        | DatabaseType::Cassandra
        | DatabaseType::Redis
        | DatabaseType::LibSQL => DriverDistribution::PluginNative,
    }
}

/// Agent SQL-read boundary. SQL and CQL engines run SELECT-shaped statements
/// directly; MongoDB's driver translates a practical SELECT subset into
/// find/aggregate commands (mongodb_sql.rs), so document engines read through
/// the same pinned read-only command. KV and search engines have no SQL
/// surface at all.
pub const fn agent_allows_sql_read(database_type: DatabaseType) -> bool {
    matches!(
        query_model_for(database_type),
        QueryModel::Sql | QueryModel::Cql | QueryModel::Document
    )
}

/// Agent write-preview boundary. The preview runs inside a rollback-only
/// transaction, so it is only honest on drivers that override
/// `preview_write_transaction` (MySQL/MariaDB, SQLite, the shared PostgreSQL
/// wire driver, MSSQL, DuckDB, libSQL, Snowflake via sequential BEGIN/COMMIT,
/// BigQuery via a rolled-back script job, Oracle via an anonymous PL/SQL
/// block). Every other engine hits the default
/// Cloudflare D1 is deliberately absent: its REST API cannot span a
/// transaction across requests, so a preview could persist writes.
pub const fn agent_allows_sql_write_preview(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::MySQL
            | DatabaseType::MariaDB
            | DatabaseType::SQLite
            | DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::Vertica
            | DatabaseType::Snowflake
            | DatabaseType::BigQuery
            | DatabaseType::Oracle
            | DatabaseType::MSSQL
            | DatabaseType::DuckDB
            | DatabaseType::LibSQL
    )
}

/// SQLite-family engines: embedded/file engines that share SQLite's SQL dialect
/// for identifier quoting and `PRAGMA foreign_keys` toggling.
///
/// Consolidated here (tech-debt audit D8): this exact 4-member group was spelled
/// out inline across `export_support.rs`, `restore.rs`, and `search.rs`. Adding
/// another SQLite-compatible engine should update this one function instead of
/// hunting every `SQLite | DuckDB | LibSQL | CloudflareD1` match arm.
pub const fn is_sqlite_family(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::SQLite
            | DatabaseType::DuckDB
            | DatabaseType::LibSQL
            | DatabaseType::CloudflareD1
    )
}

pub fn agent_sql_read_unsupported_error(database_type: DatabaseType) -> Option<String> {
    if agent_allows_sql_read(database_type) {
        return None;
    }
    let profile = driver_capabilities(database_type);
    Some(format!(
        "{} does not support SQL observations in the AI agent. Use table listing and sampling tools instead.",
        profile.label
    ))
}

pub fn agent_sql_write_preview_unsupported_error(database_type: DatabaseType) -> Option<String> {
    if agent_allows_sql_write_preview(database_type) {
        return None;
    }
    let profile = driver_capabilities(database_type);
    Some(format!(
        "{} does not support SQL write previews in the AI agent.",
        profile.label
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverCapability {
    Query,
    PreparedParameters,
    InlineEdit,
    AtomicEditQueue,
    AtomicCsvImport,
    DataExport,
    SchemaEdit,
    BackupRestore,
    Administration,
}

impl DriverCapability {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Query => "query execution",
            Self::PreparedParameters => "prepared query parameters",
            Self::InlineEdit => "inline data editing",
            Self::AtomicEditQueue => "atomic edit queue",
            Self::AtomicCsvImport => "atomic CSV import",
            Self::DataExport => "data export",
            Self::SchemaEdit => "schema editing",
            Self::BackupRestore => "backup and restore",
            Self::Administration => "database administration",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverCapabilitySet {
    pub connect: CapabilitySupport,
    pub query: CapabilitySupport,
    pub prepared_parameters: CapabilitySupport,
    pub query_cancellation: CapabilitySupport,
    pub pagination: CapabilitySupport,
    pub inline_edit: CapabilitySupport,
    pub atomic_edit_queue: CapabilitySupport,
    pub atomic_csv_import: CapabilitySupport,
    pub data_export: CapabilitySupport,
    pub explain: CapabilitySupport,
    pub schema_edit: CapabilitySupport,
    pub backup_restore: CapabilitySupport,
    pub administration: CapabilitySupport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverCapabilityProfile {
    #[serde(skip)]
    pub database_type: DatabaseType,
    pub key: &'static str,
    pub label: &'static str,
    pub tier: DriverTier,
    pub query_model: QueryModel,
    pub distribution: DriverDistribution,
    pub capabilities: DriverCapabilitySet,
    pub limitations: &'static [&'static str],
}

impl DriverCapabilityProfile {
    pub const fn support(self, capability: DriverCapability) -> CapabilitySupport {
        match capability {
            DriverCapability::Query => self.capabilities.query,
            DriverCapability::PreparedParameters => self.capabilities.prepared_parameters,
            DriverCapability::InlineEdit => self.capabilities.inline_edit,
            DriverCapability::AtomicEditQueue => self.capabilities.atomic_edit_queue,
            DriverCapability::AtomicCsvImport => self.capabilities.atomic_csv_import,
            DriverCapability::DataExport => self.capabilities.data_export,
            DriverCapability::SchemaEdit => self.capabilities.schema_edit,
            DriverCapability::BackupRestore => self.capabilities.backup_restore,
            DriverCapability::Administration => self.capabilities.administration,
        }
    }

    pub fn require(self, capability: DriverCapability) -> Result<(), String> {
        match self.support(capability) {
            CapabilitySupport::Supported => Ok(()),
            CapabilitySupport::Limited => Err(format!(
                "{} has limited {} support, so TableR keeps this action disabled until it meets the safety contract.",
                self.label,
                capability.label()
            )),
            CapabilitySupport::Unsupported | CapabilitySupport::NotApplicable => Err(format!(
                "{} does not support {} in TableR.",
                self.label,
                capability.label()
            )),
        }
    }
}
pub const ALL_DATABASE_TYPES: [DatabaseType; 24] = [
    DatabaseType::MySQL,
    DatabaseType::MariaDB,
    DatabaseType::PostgreSQL,
    DatabaseType::CockroachDB,
    DatabaseType::Greenplum,
    DatabaseType::Redshift,
    DatabaseType::SQLite,
    DatabaseType::DuckDB,
    DatabaseType::Cassandra,
    DatabaseType::Snowflake,
    DatabaseType::MSSQL,
    DatabaseType::Redis,
    DatabaseType::MongoDB,
    DatabaseType::Vertica,
    DatabaseType::ClickHouse,
    DatabaseType::BigQuery,
    DatabaseType::LibSQL,
    DatabaseType::CloudflareD1,
    DatabaseType::OpenSearch,
    DatabaseType::Elasticsearch,
    DatabaseType::Oracle,
    DatabaseType::Spanner,
    DatabaseType::DynamoDB,
    DatabaseType::Trino,
];

const S: CapabilitySupport = CapabilitySupport::Supported;
const L: CapabilitySupport = CapabilitySupport::Limited;
const U: CapabilitySupport = CapabilitySupport::Unsupported;
const N: CapabilitySupport = CapabilitySupport::NotApplicable;

#[allow(clippy::too_many_arguments)]
const fn profile(
    database_type: DatabaseType,
    key: &'static str,
    label: &'static str,
    tier: DriverTier,
    connect: CapabilitySupport,
    query: CapabilitySupport,
    prepared_parameters: CapabilitySupport,
    query_cancellation: CapabilitySupport,
    pagination: CapabilitySupport,
    inline_edit: CapabilitySupport,
    atomic_edit_queue: CapabilitySupport,
    atomic_csv_import: CapabilitySupport,
    data_export: CapabilitySupport,
    explain: CapabilitySupport,
    schema_edit: CapabilitySupport,
    backup_restore: CapabilitySupport,
    administration: CapabilitySupport,
    limitations: &'static [&'static str],
) -> DriverCapabilityProfile {
    DriverCapabilityProfile {
        database_type,
        key,
        label,
        tier,
        query_model: query_model_for(database_type),
        distribution: driver_distribution(database_type),
        capabilities: DriverCapabilitySet {
            connect,
            query,
            prepared_parameters,
            query_cancellation,
            pagination,
            inline_edit,
            atomic_edit_queue,
            atomic_csv_import,
            data_export,
            explain,
            schema_edit,
            backup_restore,
            administration,
        },
        limitations,
    }
}

/// Returns the audited capability contract for one configured database engine.
///
/// `Limited` means a path exists but does not yet meet the final product contract.
/// Callers must not treat it as equivalent to `Supported`.
pub const fn driver_capabilities(database_type: DatabaseType) -> DriverCapabilityProfile {
    match database_type {
        DatabaseType::MySQL => profile(
            database_type,
            "mysql",
            "MySQL",
            DriverTier::Core,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["Restore can retain earlier statements after a failure."],
        ),
        DatabaseType::MariaDB => profile(
            database_type,
            "mariadb",
            "MariaDB",
            DriverTier::Core,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["MariaDB currently shares the MySQL driver and capability tests."],
        ),
        DatabaseType::PostgreSQL => profile(
            database_type,
            "postgresql",
            "PostgreSQL",
            DriverTier::Core,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &[],
        ),
        DatabaseType::CockroachDB => profile(
            database_type,
            "cockroachdb",
            "CockroachDB",
            DriverTier::Extended,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["CockroachDB shares the PostgreSQL wire driver; dialect-specific schema and administration coverage is incomplete.", "Cancel issues pg_cancel_backend from a second pooled connection to abort the running statement.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied."]),
        DatabaseType::Greenplum => profile(
            database_type,
            "greenplum",
            "Greenplum",
            DriverTier::Specialized,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["Greenplum shares the PostgreSQL wire driver; distributed-operation coverage is incomplete.", "Cancel issues pg_cancel_backend from a second pooled connection to abort the running statement.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied."]),
        DatabaseType::Redshift => profile(
            database_type,
            "redshift",
            "Amazon Redshift",
            DriverTier::Specialized,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["Redshift shares the PostgreSQL wire driver; DDL, restore, and administration semantics require dedicated coverage.", "Cancel issues pg_cancel_backend from a second pooled connection to abort the running statement.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied.", "Explain returns a text plan; the JSON plan format is not supported."]),
        DatabaseType::SQLite => profile(
            database_type,
            "sqlite",
            "SQLite",
            DriverTier::Core,
            S, S, S, S, S, S, S, S, S, S, S, S, N,
            &["Cancel interrupts the running statement through a SQLite progress handler installed on the query's connection.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied."],
        ),
        DatabaseType::DuckDB => profile(
            database_type,
            "duckdb",
            "DuckDB",
            DriverTier::Extended,
            S, S, S, S, S, S, S, S, S, S, S, S, N,
            &["Restore is classified as transactional but is not yet pinned to one driver transaction.", "Cancel aborts the in-flight statement on the connection via duckdb's InterruptHandle.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied."]),
        DatabaseType::Cassandra => profile(
            database_type,
            "cassandra",
            "Apache Cassandra",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, L, S, U, S, S, S,
            &["CQL prepared parameters and tracing plans are not integrated.", "Atomic edits/imports run inside a logged BATCH capped at 100 statements / 32KB — larger queues are rejected rather than chunked.", "Schema actions run statement-by-statement; CQL has no DDL transaction.", "Cancel releases the UI but cannot abort the statement server-side; the engine may keep running it."],
        ),
        DatabaseType::Snowflake => profile(
            database_type,
            "snowflake",
            "Snowflake",
            DriverTier::Specialized,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["Atomic edits/imports and write previews run inside a sequential BEGIN…COMMIT transaction over the SQL API (session state persists via the auth token); any failure rolls back.", "Cancel issues POST /api/v2/statements/{handle}/cancel against the statement handle captured at submission."],
        ),
        DatabaseType::MSSQL => profile(
            database_type,
            "mssql",
            "SQL Server",
            DriverTier::Extended,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["Cancel kills the session from a second connection (TDS attention is not exposed by the driver), so the cancelled session is fully terminated rather than interrupted.", "Explain runs SHOWPLAN_TEXT/XML around the statement on the shared session.", "Reviewed schema changes run in one transaction; statements SQL Server forbids inside transactions (ALTER DATABASE, CREATE/DROP DATABASE, BACKUP/RESTORE, RECONFIGURE, full-text index DDL) are rejected and rolled back.", "Stored procedures are listed with definitions but there is no dedicated proc editor/executor surface."],
        ),
        DatabaseType::Redis => profile(
            database_type,
            "redis",
            "Redis",
            DriverTier::Extended,
            S, S, N, S, S, L, S, S, S, N, N, S, S,
            &["Inline edits cover mutable key types (string/hash/list/zset-score); stream payloads and identity renames are rejected.", "Atomic edits/imports queue all writes inside one MULTI/EXEC; EXEC reports per-command errors after earlier commands applied — surfaced with a partial-application note since Redis never rolls back.", "Backup/restore replays a TableR JSON snapshot inside MULTI/EXEC rather than a native Redis backup.", "Cancel kills the client session with CLIENT KILL ID from a second connection (Redis has no per-command kill), so the cancelled session is replaced rather than interrupted; requires Redis 5+ for CLIENT ID."],
        ),
        DatabaseType::MongoDB => profile(
            database_type,
            "mongodb",
            "MongoDB",
            DriverTier::Extended,
            S, S, N, S, S, S, S, S, S, S, N, S, S,
            &["Atomic edit/import queues and write previews run inside multi-document transactions — they require a replica set or mongos; standalone mongod gets a clear rejection.", "Explain wraps the translated command in the explain command; EXPLAIN uses executionStats and EXPLAIN ANALYZE uses allPlansExecution.", "Backup/export uses a TableR JSON snapshot.", "Cancel tags each command with a comment and kills the matching op via killOp; deployments without killOp privilege (e.g. shared Atlas tiers) get UI-only cancel."],
        ),
        DatabaseType::Vertica => profile(
            database_type,
            "vertica",
            "Vertica",
            DriverTier::Specialized,
            S, S, S, S, S, S, S, S, S, S, S, S, S,
            &["Vertica shares the PostgreSQL wire driver; dialect-specific DDL and administration coverage is incomplete.", "Cancel issues SELECT INTERRUPT_STATEMENT(session_id, statement_id) from a second pooled connection against the session's in-flight statement.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied.", "Explain returns a text plan; the JSON plan format is not supported."]),
        DatabaseType::ClickHouse => profile(
            database_type,
            "clickhouse",
            "ClickHouse",
            DriverTier::Extended,
            S, S, S, S, S, S, U, U, S, S, S, S, S,
            &["Prepared parameters, atomic mutations/imports, and reviewed schema actions are not implemented.", "Cancel issues KILL QUERY over a second HTTP request against the request's tagged query_id."],
        ),
        DatabaseType::BigQuery => profile(
            database_type,
            "bigquery",
            "Google BigQuery",
            DriverTier::Specialized,
            S, S, S, S, S, S, S, S, S, S, S, S, U,
            &["Atomic edits/imports run as one BEGIN…COMMIT scripting job; BigQuery rolls the script back server-side on failure.", "Write previews run as a rolled-back script job; per-statement SELECT rows are unavailable (a script returns only its last statement's rows).", "Explain runs the statement as a jobs.query dry run and surfaces byte/slot estimates; no plan text is returned.", "Administration is not integrated.", "Cancel issues jobs.cancel against the jobReference captured at submission."],
        ),
        DatabaseType::LibSQL => profile(
            database_type,
            "libsql",
            "LibSQL",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, S, S, S, S, S, N,
            &["Prepared parameters, atomic mutations/imports, and direct schema actions are not implemented.", "Cancel releases the UI but cannot abort the statement server-side; the engine may keep running it.", "Reviewed schema changes run statement-by-statement; a mid-batch failure leaves earlier statements applied."]),
        DatabaseType::CloudflareD1 => profile(
            database_type,
            "cloudflare_d1",
            "Cloudflare D1",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, S, S, S, S, S, N,
            &["Prepared parameters and direct schema actions are not implemented.", "Atomic edits/imports run as one D1 batch request (implicit transaction, all-or-nothing).", "Cancel releases the UI but cannot abort the statement server-side; the engine may keep running it."],
        ),
        DatabaseType::OpenSearch => profile(
            database_type,
            "opensearch",
            "OpenSearch",
            DriverTier::Specialized,
            S, S, N, S, S, S, N, U, S, S, N, U, S,
            &["Atomic mutations are unsupported: OpenSearch has no multi-document transaction primitive and _bulk is not atomic.", "Inline edits address documents by _id; an optional _index selector column targets the concrete index behind a pattern.", "User administration runs through the security plugin REST API.", "SQL restore is unavailable.", "Cancel tags requests with X-Opaque-Id and aborts the matching task via POST /_tasks/{task}/_cancel."],
        ),
        DatabaseType::Elasticsearch => profile(
            database_type,
            "elasticsearch",
            "Elasticsearch",
            DriverTier::Specialized,
            S, S, N, S, S, S, N, U, S, S, N, U, U,
            &["Atomic mutations are unsupported: Elasticsearch has no multi-document transaction primitive and _bulk is not atomic.", "Inline edits address documents by _id; an optional _index selector column targets the concrete index behind a pattern.", "User administration is not integrated: Elasticsearch security runs through the X-Pack _security REST API, which is out of scope.", "SQL restore is unavailable.", "Cancel tags requests with X-Opaque-Id and aborts the matching task via POST /_tasks/{task}/_cancel."],
        ),
        DatabaseType::Oracle => profile(
            database_type,
            "oracle",
            "Oracle (ORDS)",
            DriverTier::Extended,
            S, S, S, L, S, S, S, S, S, S, S, S, S,
            &["Requires ORDS (Oracle REST Data Services) enabled on the database.", "Atomic edits/imports, restore, and write previews wrap statements in one anonymous PL/SQL block so ORDS runs them in a single transaction context; per-statement rowcounts are synthesized because a block returns no per-item counts.", "Restore atomicity holds only up to the last DDL boundary — Oracle DDL implicitly commits; DML replays all-or-nothing.", "Write previews accept INSERT/UPDATE/DELETE/MERGE only — SELECT cannot appear in PL/SQL and DDL would implicitly commit before the ROLLBACK.", "User administration (dba_users, CREATE/ALTER USER, GRANT/REVOKE) requires DBA or SELECT_CATALOG_ROLE privileges.", "Cancel releases the UI but cannot abort the statement server-side; the engine may keep running it.", "Explain writes PLAN_TABLE via EXPLAIN PLAN and reads it back through DBMS_XPLAN; requires PLAN_TABLE to exist."]),
        DatabaseType::Spanner => profile(
            database_type,
            "spanner",
            "Google Spanner",
            DriverTier::Specialized,
            S, S, S, S, S, S, S, S, S, S, S, L, U,
            &["Runs over the Cloud Spanner REST API (executeSql); authentication is a Google OAuth2 access token stored in the password field.", "Atomic edits/imports and write previews run inside a read-write transaction; DDL batches through updateDatabaseDdl.", "Restore replays statements sequentially — Spanner cannot mix DDL and DML in one transaction.", "Explain runs executeSql with queryMode=PLAN and returns the plan JSON.", "Cancel deletes the session, which aborts its in-flight REST calls; the next query lazily recreates it."],
        ),
        DatabaseType::DynamoDB => profile(
            database_type,
            "dynamodb",
            "Amazon DynamoDB",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, L, S, U, L, L, U,
            &["PartiQL statements only; the driver signs requests with AWS Signature V4 using the access key in username and secret key in password.", "Atomic edits/imports run inside ExecuteTransaction capped at 100 actions — larger queues are rejected rather than chunked.", "Schema actions are limited to CREATE TABLE (partition key, optional sort key) and DROP TABLE via the control-plane API; explain and administration are not implemented.", "Restore replays JSON snapshots and PartiQL INSERTs; a table under the 100-action cap restores inside ExecuteTransaction, larger tables replay sequentially.", "Cancel aborts NextToken paging client-side; DynamoDB cannot kill a running statement server-side."],
        ),
        DatabaseType::Trino => profile(
            database_type,
            "trino",
            "Trino",
            DriverTier::Extended,
            S, S, S, S, S, S, S, S, S, S, S, S, U,
            &["Runs over the Trino HTTP protocol (/v1/statement); the driver follows nextUri pages until the coordinator reports no more data.", "Atomic edits/imports and write previews pin statements to a coordinator transaction (X-Trino-Transaction-Id); connectors without transaction support reject START TRANSACTION honestly.", "Prepared parameters run through PREPARE/EXECUTE with escaped literals — Trino has no wire-level binds.", "Cancel issues HTTP DELETE on the running query URI."],
        ),
    }
}

pub fn all_driver_capabilities() -> Vec<DriverCapabilityProfile> {
    ALL_DATABASE_TYPES
        .iter()
        .copied()
        .map(driver_capabilities)
        .collect()
}

/// Protocols the built-in `declarative-http-v1` plugin host can drive. These are
/// exactly the HTTP/REST engines (`DriverDistribution::PluginHttp`), so an
/// installed plugin manifest may only contribute a driver for an engine TableR
/// ships a compiled HTTP driver for. Derived from the matrix so the allow-list
/// cannot drift from the packaging taxonomy.
pub fn is_declarative_http_protocol(protocol: &str) -> bool {
    ALL_DATABASE_TYPES.iter().copied().any(|database_type| {
        let profile = driver_capabilities(database_type);
        profile.key == protocol && matches!(profile.distribution, DriverDistribution::PluginHttp)
    })
}

/// Whether `protocol` names one of the `DriverDistribution::PluginNative`
/// engines (DuckDB, Cassandra, Redis, LibSQL). Mirrors
/// `is_declarative_http_protocol` for the native-sidecar (`driver-sidecar-v1`)
/// runtime: an installed sidecar plugin may only contribute a driver for an
/// engine TableR classifies as native. Derived from the matrix so the allow-list
/// cannot drift from the packaging taxonomy.
pub fn is_plugin_native_protocol(protocol: &str) -> bool {
    ALL_DATABASE_TYPES.iter().copied().any(|database_type| {
        let profile = driver_capabilities(database_type);
        profile.key == protocol && matches!(profile.distribution, DriverDistribution::PluginNative)
    })
}

/// Which `DriverDistribution::PluginNative` engines (DuckDB, Cassandra, Redis,
/// LibSQL) are actually compiled into this build. Unlike the HTTP plugins, these
/// link a wire-protocol crate at build time behind a Cargo feature, so a lean
/// build can drop them to shrink the binary. This MUST be evaluated with `cfg!`
/// (never a const table) so the report reflects the real feature set, letting
/// the frontend gate the connection picker instead of failing only at connect.
/// The key strings mirror `DriverCapabilityProfile::key`, and a test pins that
/// this list stays exactly the `PluginNative` set in the matrix.
pub fn compiled_native_driver_availability() -> Vec<(&'static str, bool)> {
    vec![
        ("duckdb", cfg!(feature = "duckdb-driver")),
        ("cassandra", cfg!(feature = "cassandra-driver")),
        ("redis", cfg!(feature = "redis-driver")),
        ("libsql", cfg!(feature = "libsql-driver")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn plugin_native_protocol_allowlist_matches_the_matrix() {
        // The sidecar runtime accepts exactly the PluginNative engines, sourced
        // from the same matrix as the packaging taxonomy so it cannot drift.
        for database_type in ALL_DATABASE_TYPES.iter().copied() {
            let profile = driver_capabilities(database_type);
            let expected = matches!(profile.distribution, DriverDistribution::PluginNative);
            assert_eq!(
                is_plugin_native_protocol(profile.key),
                expected,
                "{}",
                profile.key
            );
        }
        assert!(is_plugin_native_protocol("duckdb"));
        assert!(is_plugin_native_protocol("redis"));
        // HTTP-plugin and built-in protocols are rejected by the native gate.
        assert!(!is_plugin_native_protocol("clickhouse"));
        assert!(!is_plugin_native_protocol("mysql"));
    }

    #[test]
    fn capability_catalog_contains_every_engine_once() {
        let catalog = all_driver_capabilities();
        assert_eq!(catalog.len(), ALL_DATABASE_TYPES.len());

        let keys = catalog
            .iter()
            .map(|profile| profile.key)
            .collect::<HashSet<_>>();
        assert_eq!(keys.len(), ALL_DATABASE_TYPES.len());
    }

    #[test]
    fn sqlite_family_is_exactly_the_embedded_sqlite_dialect_engines() {
        for database_type in ALL_DATABASE_TYPES {
            let expected = matches!(
                database_type,
                DatabaseType::SQLite
                    | DatabaseType::DuckDB
                    | DatabaseType::LibSQL
                    | DatabaseType::CloudflareD1
            );
            assert_eq!(
                is_sqlite_family(database_type),
                expected,
                "is_sqlite_family mismatch for {database_type:?}"
            );
        }
    }

    #[test]
    fn tier_a_contracts_are_not_silently_limited_for_core_data_paths() {
        for profile in all_driver_capabilities()
            .into_iter()
            .filter(|profile| profile.tier == DriverTier::Core)
        {
            assert_eq!(profile.capabilities.connect, S, "{} connect", profile.key);
            assert_eq!(profile.capabilities.query, S, "{} query", profile.key);
            assert_eq!(
                profile.capabilities.pagination, S,
                "{} pagination",
                profile.key
            );
            assert_eq!(profile.capabilities.inline_edit, S, "{} edit", profile.key);
            assert_eq!(
                profile.capabilities.atomic_edit_queue, S,
                "{} atomic edit",
                profile.key
            );
            assert_eq!(
                profile.capabilities.atomic_csv_import, S,
                "{} atomic import",
                profile.key
            );
            assert_eq!(
                profile.capabilities.data_export, S,
                "{} export",
                profile.key
            );
        }
    }

    #[test]
    fn agent_sql_tools_follow_query_model() {
        assert_eq!(query_model_for(DatabaseType::PostgreSQL), QueryModel::Sql);
        assert_eq!(query_model_for(DatabaseType::ClickHouse), QueryModel::Sql);
        assert_eq!(query_model_for(DatabaseType::Cassandra), QueryModel::Cql);
        assert_eq!(query_model_for(DatabaseType::MongoDB), QueryModel::Document);
        assert_eq!(query_model_for(DatabaseType::Redis), QueryModel::Kv);
        assert_eq!(
            query_model_for(DatabaseType::OpenSearch),
            QueryModel::Search
        );

        assert!(agent_allows_sql_read(DatabaseType::ClickHouse));
        assert!(agent_allows_sql_read(DatabaseType::Cassandra));
        assert!(!agent_allows_sql_read(DatabaseType::Redis));
        assert!(agent_allows_sql_read(DatabaseType::MongoDB));
        assert!(!agent_allows_sql_read(DatabaseType::OpenSearch));

        assert!(agent_allows_sql_write_preview(DatabaseType::PostgreSQL));
        assert!(!agent_allows_sql_write_preview(DatabaseType::ClickHouse));
        assert!(!agent_allows_sql_write_preview(DatabaseType::Cassandra));
        assert!(!agent_allows_sql_write_preview(DatabaseType::Redis));
        assert!(agent_sql_read_unsupported_error(DatabaseType::Redis).is_some());
        assert!(agent_sql_read_unsupported_error(DatabaseType::PostgreSQL).is_none());
    }

    #[test]
    fn every_engine_has_an_explicit_agent_sql_policy() {
        for database_type in ALL_DATABASE_TYPES {
            let model = query_model_for(database_type);
            let read = agent_allows_sql_read(database_type);
            let write = agent_allows_sql_write_preview(database_type);
            let preview_capable = matches!(
                database_type,
                DatabaseType::MySQL
                    | DatabaseType::MariaDB
                    | DatabaseType::SQLite
                    | DatabaseType::PostgreSQL
                    | DatabaseType::CockroachDB
                    | DatabaseType::Greenplum
                    | DatabaseType::Redshift
                    | DatabaseType::Vertica
                    | DatabaseType::MSSQL
                    | DatabaseType::DuckDB
                    | DatabaseType::LibSQL
                    | DatabaseType::Snowflake
                    | DatabaseType::BigQuery
                    | DatabaseType::Oracle
            );
            match model {
                QueryModel::Sql => {
                    assert!(read, "{database_type:?} sql must allow reads");
                    assert_eq!(
                        write, preview_capable,
                        "{database_type:?} write preview must match the driver impl"
                    );
                    assert!(agent_sql_read_unsupported_error(database_type).is_none());
                    assert_eq!(
                        agent_sql_write_preview_unsupported_error(database_type).is_none(),
                        preview_capable
                    );
                }
                QueryModel::Cql => {
                    assert!(read, "{database_type:?} cql must allow SELECT-shaped reads");
                    assert!(
                        !write,
                        "{database_type:?} cql must not allow SQL write previews"
                    );
                    assert!(agent_sql_write_preview_unsupported_error(database_type).is_some());
                }
                QueryModel::Document => {
                    assert!(
                        read,
                        "{database_type:?} document engine reads via the translated SELECT subset"
                    );
                    assert!(
                        !write,
                        "{database_type:?} must not allow SQL write previews"
                    );
                    assert!(agent_sql_read_unsupported_error(database_type).is_none());
                }
                QueryModel::Kv | QueryModel::Search => {
                    assert!(!read, "{database_type:?} must not allow SQL reads");
                    assert!(
                        !write,
                        "{database_type:?} must not allow SQL write previews"
                    );
                    let err = agent_sql_read_unsupported_error(database_type).expect("error");
                    assert!(err.contains("does not support SQL observations"));
                }
            }
        }
    }

    #[test]
    fn distribution_split_matches_the_plugin_taxonomy() {
        use DriverDistribution::*;
        for database_type in ALL_DATABASE_TYPES {
            let expected = match database_type {
                DatabaseType::MySQL
                | DatabaseType::MariaDB
                | DatabaseType::PostgreSQL
                | DatabaseType::CockroachDB
                | DatabaseType::Greenplum
                | DatabaseType::Redshift
                | DatabaseType::Vertica
                | DatabaseType::SQLite
                | DatabaseType::MSSQL
                | DatabaseType::MongoDB => Builtin,
                DatabaseType::ClickHouse
                | DatabaseType::BigQuery
                | DatabaseType::Snowflake
                | DatabaseType::CloudflareD1
                | DatabaseType::OpenSearch
                | DatabaseType::Elasticsearch
                | DatabaseType::Oracle
                | DatabaseType::Spanner
                | DatabaseType::DynamoDB
                | DatabaseType::Trino => PluginHttp,
                DatabaseType::DuckDB
                | DatabaseType::Cassandra
                | DatabaseType::Redis
                | DatabaseType::LibSQL => PluginNative,
            };
            assert_eq!(
                driver_capabilities(database_type).distribution,
                expected,
                "distribution mismatch for {database_type:?}"
            );
        }
    }

    #[test]
    fn native_availability_keys_match_the_plugin_native_taxonomy() {
        // The build-availability report must cover exactly the PluginNative
        // engines in the matrix, so a newly added native engine cannot silently
        // escape the feature-flag surface the frontend gates its picker on.
        let reported = compiled_native_driver_availability()
            .into_iter()
            .map(|(key, _)| key)
            .collect::<HashSet<_>>();
        let expected = all_driver_capabilities()
            .into_iter()
            .filter(|p| p.distribution == DriverDistribution::PluginNative)
            .map(|p| p.key)
            .collect::<HashSet<_>>();
        assert_eq!(
            reported, expected,
            "native availability keys drifted from the plugin_native taxonomy"
        );
    }

    #[test]
    fn native_availability_reflects_the_active_feature_set() {
        // The report must mirror the real cfg! surface under any feature set
        // (default or lean), so lean builds truthfully hide dropped engines.
        let map: std::collections::HashMap<_, _> =
            compiled_native_driver_availability().into_iter().collect();
        assert_eq!(map["duckdb"], cfg!(feature = "duckdb-driver"));
        assert_eq!(map["cassandra"], cfg!(feature = "cassandra-driver"));
        assert_eq!(map["redis"], cfg!(feature = "redis-driver"));
        assert_eq!(map["libsql"], cfg!(feature = "libsql-driver"));
    }

    #[test]
    fn builtin_set_is_backed_by_the_five_shipped_wire_drivers() {
        let builtin = all_driver_capabilities()
            .into_iter()
            .filter(|p| p.distribution == DriverDistribution::Builtin)
            .map(|p| p.key)
            .collect::<HashSet<_>>();
        // The five engines the product keeps built-in must always stay in-app.
        for key in ["mysql", "postgresql", "sqlite", "mssql", "mongodb"] {
            assert!(builtin.contains(key), "{key} must remain built-in");
        }
        // HTTP and native-crate engines are never built-in.
        for key in [
            "clickhouse",
            "bigquery",
            "snowflake",
            "cloudflare_d1",
            "opensearch",
            "elasticsearch",
            "oracle",
            "spanner",
            "dynamodb",
            "trino",
        ] {
            assert!(
                !builtin.contains(key),
                "{key} must be a plugin, not built-in"
            );
        }
        for key in ["duckdb", "cassandra", "redis", "libsql"] {
            assert!(
                !builtin.contains(key),
                "{key} must be a plugin, not built-in"
            );
        }
    }

    #[test]
    fn committed_json_matrix_matches_the_rust_catalog() {
        let expected = serde_json::to_string_pretty(&all_driver_capabilities()).unwrap() + "\n";
        // include_str! embeds the file as it exists on disk at compile time, so
        // a Windows checkout (core.autocrlf) would otherwise compare CRLF text
        // against LF expectations. Normalize before comparing; the committed
        // blob itself is always LF (enforced by .gitattributes).
        let committed =
            include_str!("../../../docs/generated/driver-capabilities.json").replace("\r\n", "\n");
        assert_eq!(committed, expected, "regenerate the capability matrix");
    }

    #[test]
    #[ignore]
    fn write_committed_matrix() {
        let json = serde_json::to_string_pretty(&all_driver_capabilities()).unwrap() + "\n";
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../docs/generated/driver-capabilities.json"
            ),
            json,
        )
        .unwrap();
    }
}
