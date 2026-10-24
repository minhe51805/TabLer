mod support;

use support::{
    base_config, envs_ready, insert_env, integration_enabled, plugin_bundle, probe_connection,
    required_env, sql_config, EngineProbe,
};
use tabler_lib::database::models::DatabaseType;

macro_rules! engine_case {
    ($name:ident, $envs:expr, $config:expr, $bundle:expr, $probe:expr) => {
        #[tokio::test]
        async fn $name() {
            if !integration_enabled() {
                eprintln!("skipped: set TABLER_DRIVER_INTEGRATION=1 to enable");
                return;
            }
            if !envs_ready($envs) {
                eprintln!("skipped: required service credentials are not configured");
                return;
            }
            probe_connection($config, $bundle, $probe)
                .await
                .expect(stringify!($name));
        }
    };
}

engine_case!(
    mysql_builtin_live,
    &[],
    sql_config(DatabaseType::MySQL, 13306, "tabler_test"),
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    mariadb_builtin_live,
    &[],
    sql_config(DatabaseType::MariaDB, 13307, "tabler_test"),
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    postgres_builtin_live,
    &[],
    sql_config(DatabaseType::PostgreSQL, 15432, "tabler_test"),
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    cockroachdb_builtin_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::CockroachDB, 26257, "defaultdb");
        config.username = Some("root".to_string());
        config.password = Some(String::new());
        config
    },
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    greenplum_builtin_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::Greenplum, 25432, "gpadmin");
        config.username = Some("gpadmin".to_string());
        config.password = Some("gpadmin".to_string());
        config
    },
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    redshift_builtin_live,
    &[
        "TABLER_IT_REDSHIFT_HOST",
        "TABLER_IT_REDSHIFT_USER",
        "TABLER_IT_REDSHIFT_PASSWORD",
        "TABLER_IT_REDSHIFT_DATABASE"
    ],
    {
        let mut config = base_config(DatabaseType::Redshift);
        config.host = Some(required_env("TABLER_IT_REDSHIFT_HOST"));
        config.port = Some(
            required_env("TABLER_IT_REDSHIFT_PORT")
                .parse()
                .unwrap_or(5439),
        );
        config.username = Some(required_env("TABLER_IT_REDSHIFT_USER"));
        config.password = Some(required_env("TABLER_IT_REDSHIFT_PASSWORD"));
        config.database = Some(required_env("TABLER_IT_REDSHIFT_DATABASE"));
        config
    },
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(sqlite_builtin_live, &[], {
    let mut config = base_config(DatabaseType::SQLite);
    config.file_path = Some(std::env::temp_dir().join(format!("tabler-matrix-{}.db", std::process::id())).to_string_lossy().to_string());
    config
}, None, EngineProbe::Sql("CREATE TABLE IF NOT EXISTS matrix_probe (id INTEGER); INSERT INTO matrix_probe VALUES (1); SELECT * FROM matrix_probe"));
engine_case!(
    mssql_builtin_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::MSSQL, 11433, "master");
        config.username = Some("sa".to_string());
        config.password = Some("TablerIntegration!123".to_string());
        config
    },
    None,
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    mongodb_builtin_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::MongoDB, 27027, "admin");
        config.username = None;
        config.password = None;
        config
    },
    None,
    EngineProbe::ListDatabases
);
engine_case!(
    vertica_builtin_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::Vertica, 25433, "docker");
        config.username = Some("dbadmin".to_string());
        config.password = Some(String::new());
        config
    },
    None,
    EngineProbe::VerticaWorkspace
);

engine_case!(
    clickhouse_http_live,
    &[],
    sql_config(DatabaseType::ClickHouse, 18123, "default"),
    Some(plugin_bundle("clickhouse-driver")),
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    bigquery_http_live,
    &["TABLER_IT_BIGQUERY_TOKEN", "TABLER_IT_BIGQUERY_PROJECT_ID"],
    {
        let mut config = base_config(DatabaseType::BigQuery);
        config.password = Some(required_env("TABLER_IT_BIGQUERY_TOKEN"));
        config.additional_fields.insert(
            "project_id".to_string(),
            required_env("TABLER_IT_BIGQUERY_PROJECT_ID"),
        );
        insert_env(&mut config, "dataset", "TABLER_IT_BIGQUERY_DATASET");
        insert_env(&mut config, "location", "TABLER_IT_BIGQUERY_LOCATION");
        config
    },
    Some(plugin_bundle("bigquery-driver")),
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    snowflake_http_live,
    &["TABLER_IT_SNOWFLAKE_ACCOUNT", "TABLER_IT_SNOWFLAKE_TOKEN"],
    {
        let mut config = base_config(DatabaseType::Snowflake);
        config.host = Some(required_env("TABLER_IT_SNOWFLAKE_ACCOUNT"));
        config.password = Some(required_env("TABLER_IT_SNOWFLAKE_TOKEN"));
        config.database = std::env::var("TABLER_IT_SNOWFLAKE_DATABASE").ok();
        insert_env(&mut config, "warehouse", "TABLER_IT_SNOWFLAKE_WAREHOUSE");
        insert_env(&mut config, "role", "TABLER_IT_SNOWFLAKE_ROLE");
        insert_env(&mut config, "schema", "TABLER_IT_SNOWFLAKE_SCHEMA");
        config
    },
    Some(plugin_bundle("snowflake-driver")),
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    cloudflare_d1_http_live,
    &[
        "TABLER_IT_D1_TOKEN",
        "TABLER_IT_D1_ACCOUNT_ID",
        "TABLER_IT_D1_DATABASE_ID"
    ],
    {
        let mut config = base_config(DatabaseType::CloudflareD1);
        config.password = Some(required_env("TABLER_IT_D1_TOKEN"));
        config.additional_fields.insert(
            "account_id".to_string(),
            required_env("TABLER_IT_D1_ACCOUNT_ID"),
        );
        config.additional_fields.insert(
            "database_id".to_string(),
            required_env("TABLER_IT_D1_DATABASE_ID"),
        );
        config
    },
    Some(plugin_bundle("cloudflare-d1-driver")),
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    opensearch_http_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::OpenSearch, 19200, "logs");
        config.username = None;
        config.password = None;
        config
    },
    Some(plugin_bundle("opensearch-driver")),
    EngineProbe::ListTables
);
engine_case!(
    elasticsearch_http_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::Elasticsearch, 19201, "logs");
        config.username = None;
        config.password = None;
        config
    },
    Some(plugin_bundle("elasticsearch-driver")),
    EngineProbe::ListTables
);
engine_case!(
    oracle_http_live,
    &[
        "TABLER_IT_ORACLE_HOST",
        "TABLER_IT_ORACLE_USERNAME",
        "TABLER_IT_ORACLE_PASSWORD",
        "TABLER_IT_ORACLE_DATABASE"
    ],
    {
        let mut config = base_config(DatabaseType::Oracle);
        config.host = Some(required_env("TABLER_IT_ORACLE_HOST"));
        config.port = Some(required_env("TABLER_IT_ORACLE_PORT").parse().unwrap_or(443));
        config.username = Some(required_env("TABLER_IT_ORACLE_USERNAME"));
        config.password = Some(required_env("TABLER_IT_ORACLE_PASSWORD"));
        config.database = Some(required_env("TABLER_IT_ORACLE_DATABASE"));
        config.use_ssl = std::env::var("TABLER_IT_ORACLE_USE_SSL").as_deref() == Ok("1");
        config
    },
    Some(plugin_bundle("oracle-driver")),
    EngineProbe::Sql("SELECT 1 FROM dual")
);
engine_case!(
    spanner_http_live,
    &[
        "TABLER_IT_SPANNER_INSTANCE_PATH",
        "TABLER_IT_SPANNER_DATABASE",
        "TABLER_IT_SPANNER_TOKEN"
    ],
    {
        let mut config = base_config(DatabaseType::Spanner);
        config.host = Some(required_env("TABLER_IT_SPANNER_INSTANCE_PATH"));
        config.database = Some(required_env("TABLER_IT_SPANNER_DATABASE"));
        config.password = Some(required_env("TABLER_IT_SPANNER_TOKEN"));
        config
    },
    Some(plugin_bundle("spanner-driver")),
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    dynamodb_http_live,
    &[
        "TABLER_IT_DYNAMODB_HOST",
        "TABLER_IT_DYNAMODB_ACCESS_KEY",
        "TABLER_IT_DYNAMODB_SECRET_KEY"
    ],
    {
        let mut config = base_config(DatabaseType::DynamoDB);
        config.host = Some(required_env("TABLER_IT_DYNAMODB_HOST"));
        config.username = Some(required_env("TABLER_IT_DYNAMODB_ACCESS_KEY"));
        config.password = Some(required_env("TABLER_IT_DYNAMODB_SECRET_KEY"));
        insert_env(&mut config, "region", "TABLER_IT_DYNAMODB_REGION");
        insert_env(
            &mut config,
            "session_token",
            "TABLER_IT_DYNAMODB_SESSION_TOKEN",
        );
        config
    },
    Some(plugin_bundle("dynamodb-driver")),
    EngineProbe::ListTables
);
engine_case!(
    trino_http_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::Trino, 18081, "default");
        config.password = None;
        config
    },
    Some(plugin_bundle("trino-driver")),
    EngineProbe::Sql("SELECT 1")
);
engine_case!(
    typesense_http_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::Typesense, 18108, "default");
        config.password = Some(
            std::env::var("TABLER_IT_TYPESENSE_API_KEY").unwrap_or_else(|_| "tabler".to_string()),
        );
        config
    },
    Some(plugin_bundle("typesense-driver")),
    EngineProbe::ListTables
);
engine_case!(
    surrealdb_http_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::SurrealDB, 18000, "main");
        config.username = Some("root".to_string());
        config.password = Some("root".to_string());
        config
            .additional_fields
            .insert("namespace".to_string(), "main".to_string());
        config
    },
    Some(plugin_bundle("surrealdb-driver")),
    EngineProbe::ListTables
);
engine_case!(
    weaviate_http_live,
    &[],
    {
        let mut config = sql_config(DatabaseType::Weaviate, 18083, "default");
        config.username = None;
        config.password = None;
        config
    },
    Some(plugin_bundle("weaviate-driver")),
    EngineProbe::ListTables
);
