use super::models::DatabaseType;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverTier {
    Core,
    Extended,
    Specialized,
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
/// (`run_readonly_sql`, `preview_write`) only apply to `Sql` (and CQL SELECT).
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
        DatabaseType::OpenSearch => QueryModel::Search,
        DatabaseType::Cassandra => QueryModel::Cql,
        _ => QueryModel::Sql,
    }
}

pub const fn agent_allows_sql_read(database_type: DatabaseType) -> bool {
    matches!(
        query_model_for(database_type),
        QueryModel::Sql | QueryModel::Cql
    )
}

pub const fn agent_allows_sql_write_preview(database_type: DatabaseType) -> bool {
    matches!(query_model_for(database_type), QueryModel::Sql)
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

pub const ALL_DATABASE_TYPES: [DatabaseType; 19] = [
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
            S, S, S, S, S, S, S, S, S, S, S, L, S,
            &["Restore can retain earlier statements after a failure."],
        ),
        DatabaseType::MariaDB => profile(
            database_type,
            "mariadb",
            "MariaDB",
            DriverTier::Core,
            S, S, S, S, S, S, S, S, S, S, S, L, S,
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
            S, S, S, L, S, S, S, S, S, S, L, L, L,
            &["CockroachDB shares the PostgreSQL wire driver; dialect-specific schema and administration coverage is incomplete."],
        ),
        DatabaseType::Greenplum => profile(
            database_type,
            "greenplum",
            "Greenplum",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, S, S, S, L, L, L,
            &["Greenplum shares the PostgreSQL wire driver; distributed-operation coverage is incomplete."],
        ),
        DatabaseType::Redshift => profile(
            database_type,
            "redshift",
            "Amazon Redshift",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, S, S, L, L, L, L,
            &["Redshift shares the PostgreSQL wire driver; DDL, restore, and administration semantics require dedicated coverage."],
        ),
        DatabaseType::SQLite => profile(
            database_type,
            "sqlite",
            "SQLite",
            DriverTier::Core,
            S, S, S, L, S, S, S, S, S, S, U, S, N,
            &["Local engine: cancel stops waiting; the embedded engine finishes the statement in the background.", "Direct column schema changes are not wired into TableR actions yet."],
        ),
        DatabaseType::DuckDB => profile(
            database_type,
            "duckdb",
            "DuckDB",
            DriverTier::Extended,
            S, S, S, L, S, S, U, U, S, S, U, L, N,
            &["Atomic edit queues and CSV imports are not implemented.", "Restore is classified as transactional but is not yet pinned to one driver transaction."],
        ),
        DatabaseType::Cassandra => profile(
            database_type,
            "cassandra",
            "Apache Cassandra",
            DriverTier::Specialized,
            S, S, U, L, S, S, U, U, S, U, U, L, L,
            &["CQL prepared parameters, tracing plans, atomic imports, and schema actions are not integrated."],
        ),
        DatabaseType::Snowflake => profile(
            database_type,
            "snowflake",
            "Snowflake",
            DriverTier::Specialized,
            S, S, U, L, S, S, U, U, S, S, U, L, L,
            &["Prepared parameters, atomic edits/imports, and reviewed schema actions are not implemented."],
        ),
        DatabaseType::MSSQL => profile(
            database_type,
            "mssql",
            "SQL Server",
            DriverTier::Extended,
            S, S, S, L, S, S, U, U, S, L, U, L, L,
            &["Server-side cancellation, atomic edit/import queues, and reviewed schema actions are incomplete."],
        ),
        DatabaseType::Redis => profile(
            database_type,
            "redis",
            "Redis",
            DriverTier::Extended,
            S, S, N, L, S, U, N, U, S, N, N, L, L,
            &["Redis key projections are read-only; mutations require the CLI tab.", "Backup/export uses a TableR JSON snapshot rather than a native Redis backup."],
        ),
        DatabaseType::MongoDB => profile(
            database_type,
            "mongodb",
            "MongoDB",
            DriverTier::Extended,
            S, S, N, L, S, S, U, U, S, U, N, L, L,
            &["Atomic edit/import queues and explain integration are not implemented.", "Backup/export uses a TableR JSON snapshot."],
        ),
        DatabaseType::Vertica => profile(
            database_type,
            "vertica",
            "Vertica",
            DriverTier::Specialized,
            S, S, S, L, S, S, S, S, S, L, L, L, L,
            &["Vertica shares the PostgreSQL wire driver; dialect-specific DDL and administration coverage is incomplete."],
        ),
        DatabaseType::ClickHouse => profile(
            database_type,
            "clickhouse",
            "ClickHouse",
            DriverTier::Extended,
            S, S, U, L, S, S, U, U, S, S, U, L, L,
            &["Prepared parameters, atomic mutations/imports, and reviewed schema actions are not implemented."],
        ),
        DatabaseType::BigQuery => profile(
            database_type,
            "bigquery",
            "Google BigQuery",
            DriverTier::Specialized,
            S, S, U, L, S, S, U, U, S, U, U, L, U,
            &["Prepared parameters, atomic mutations/imports, explain plans, and administration are not integrated."],
        ),
        DatabaseType::LibSQL => profile(
            database_type,
            "libsql",
            "LibSQL",
            DriverTier::Specialized,
            S, S, U, L, S, S, U, U, S, S, U, L, N,
            &["Prepared parameters, atomic mutations/imports, and direct schema actions are not implemented."],
        ),
        DatabaseType::CloudflareD1 => profile(
            database_type,
            "cloudflare_d1",
            "Cloudflare D1",
            DriverTier::Specialized,
            S, S, U, L, S, S, U, U, S, S, U, L, N,
            &["Prepared parameters, atomic mutations/imports, and direct schema actions are not implemented."],
        ),
        DatabaseType::OpenSearch => profile(
            database_type,
            "opensearch",
            "OpenSearch",
            DriverTier::Specialized,
            S, S, N, L, S, U, N, U, S, U, N, U, U,
            &["The declarative OpenSearch plugin driver is read-only.", "SQL restore and server administration are unavailable."],
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

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
    fn read_only_projection_drivers_do_not_advertise_edits() {
        for database_type in [DatabaseType::Redis, DatabaseType::OpenSearch] {
            let profile = driver_capabilities(database_type);
            assert_ne!(profile.capabilities.inline_edit, S);
            assert_ne!(profile.capabilities.atomic_edit_queue, S);
            assert_ne!(profile.capabilities.atomic_csv_import, S);
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
        assert!(!agent_allows_sql_read(DatabaseType::MongoDB));
        assert!(!agent_allows_sql_read(DatabaseType::OpenSearch));

        assert!(agent_allows_sql_write_preview(DatabaseType::ClickHouse));
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
            match model {
                QueryModel::Sql => {
                    assert!(read, "{database_type:?} sql must allow reads");
                    assert!(write, "{database_type:?} sql must allow write previews");
                    assert!(agent_sql_read_unsupported_error(database_type).is_none());
                    assert!(agent_sql_write_preview_unsupported_error(database_type).is_none());
                }
                QueryModel::Cql => {
                    assert!(read, "{database_type:?} cql must allow SELECT-shaped reads");
                    assert!(
                        !write,
                        "{database_type:?} cql must not allow SQL write previews"
                    );
                    assert!(agent_sql_write_preview_unsupported_error(database_type).is_some());
                }
                QueryModel::Document | QueryModel::Kv | QueryModel::Search => {
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
}
