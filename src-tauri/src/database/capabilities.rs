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
        | DatabaseType::OpenSearch => DriverDistribution::PluginHttp,
        DatabaseType::DuckDB
        | DatabaseType::Cassandra
        | DatabaseType::Redis
        | DatabaseType::LibSQL => DriverDistribution::PluginNative,
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

/// Protocols the built-in `declarative-http-v1` plugin host can drive. These are
/// exactly the HTTP/REST engines (`DriverDistribution::PluginHttp`), so an
/// installed plugin manifest may only contribute a driver for an engine TableR
/// ships a compiled HTTP driver for. Derived from the matrix so the allow-list
/// cannot drift from the packaging taxonomy.
pub fn is_declarative_http_protocol(protocol: &str) -> bool {
    ALL_DATABASE_TYPES.iter().copied().any(|database_type| {
        let profile = driver_capabilities(database_type);
        profile.key == protocol
            && matches!(profile.distribution, DriverDistribution::PluginHttp)
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
        profile.key == protocol
            && matches!(profile.distribution, DriverDistribution::PluginNative)
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
                | DatabaseType::OpenSearch => PluginHttp,
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
        for key in ["clickhouse", "bigquery", "snowflake", "cloudflare_d1", "opensearch"] {
            assert!(!builtin.contains(key), "{key} must be a plugin, not built-in");
        }
        for key in ["duckdb", "cassandra", "redis", "libsql"] {
            assert!(!builtin.contains(key), "{key} must be a plugin, not built-in");
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
