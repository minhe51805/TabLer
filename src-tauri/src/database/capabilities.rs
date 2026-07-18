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
    pub capabilities: DriverCapabilitySet,
    pub limitations: &'static [&'static str],
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
            S, S, S, L, S, S, S, S, S, S, S, L, S,
            &["Query timeout does not yet guarantee server-side cancellation.", "Restore can retain earlier statements after a failure."],
        ),
        DatabaseType::MariaDB => profile(
            database_type,
            "mariadb",
            "MariaDB",
            DriverTier::Core,
            S, S, S, L, S, S, S, S, S, S, S, L, S,
            &["Query timeout does not yet guarantee server-side cancellation.", "MariaDB currently shares the MySQL driver and capability tests."],
        ),
        DatabaseType::PostgreSQL => profile(
            database_type,
            "postgresql",
            "PostgreSQL",
            DriverTier::Core,
            S, S, S, L, S, S, S, S, S, S, S, S, S,
            &["Query timeout does not yet guarantee server-side cancellation."],
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
            &["Query timeout does not interrupt every SQLite operation.", "Direct column schema changes are not wired into TableR actions yet."],
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
    fn committed_json_matrix_matches_the_rust_catalog() {
        let expected = serde_json::to_string_pretty(&all_driver_capabilities()).unwrap() + "\n";
        let committed = include_str!("../../../docs/generated/driver-capabilities.json");
        assert_eq!(committed, expected, "regenerate the capability matrix");
    }
}
