use super::connection::{ConnectionConfig, DatabaseType};
use std::fs;
use std::path::{Component, Path};

impl ConnectionConfig {
    /// Validate connection config before attempting to connect
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("Connection name cannot be empty".to_string());
        }

        // Validate ID format (UUID)
        if self.id.trim().is_empty() {
            return Err("Connection ID cannot be empty".to_string());
        }

        // SQLite only requires file_path, other databases require host
        match self.db_type {
            DatabaseType::SQLite => {
                let path = self
                    .file_path
                    .as_deref()
                    .ok_or_else(|| "SQLite file path is required".to_string())?;
                validate_local_file_path(
                    path,
                    &["db", "db3", "sqlite", "sqlite3"],
                    "SQLite file path",
                    "SQLite",
                )?;
            }
            DatabaseType::DuckDB => {
                let path = self
                    .file_path
                    .as_deref()
                    .ok_or_else(|| "DuckDB file path is required".to_string())?;
                validate_local_file_path(
                    path,
                    &["duckdb", "ddb", "db"],
                    "DuckDB file path",
                    "DuckDB",
                )?;
            }
            DatabaseType::CloudflareD1 => {
                let account_id = self
                    .additional_fields
                    .get("account_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Cloudflare account ID is required".to_string())?;
                if account_id.len() > 64 {
                    return Err("Cloudflare account ID is too long".to_string());
                }

                let database_id = self
                    .additional_fields
                    .get("database_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Cloudflare D1 database ID is required".to_string())?;
                if database_id.len() > 128 {
                    return Err("Cloudflare D1 database ID is too long".to_string());
                }

                let token = self
                    .password
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Cloudflare API token is required".to_string())?;
                if token.len() > 512 {
                    return Err("Cloudflare API token is too long".to_string());
                }

                if let Some(host) = self
                    .host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    validate_network_host(host)?;
                }
            }
            DatabaseType::Snowflake => {
                let host = self
                    .host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Snowflake account host is required".to_string())?;
                validate_network_host(host)?;

                let token = self
                    .password
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        "Snowflake auth token is required (programmatic access token, OAuth token, or JWT)"
                            .to_string()
                    })?;
                if token.len() > 8192 {
                    return Err("Snowflake auth token is too long".to_string());
                }

                if let Some(database) = self
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if database.len() > 256 {
                        return Err("Snowflake database name is too long".to_string());
                    }
                }

                if let Some(warehouse) = self
                    .additional_fields
                    .get("warehouse")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if warehouse.len() > 256 {
                        return Err("Snowflake warehouse name is too long".to_string());
                    }
                }

                if let Some(schema) = self
                    .additional_fields
                    .get("schema")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if schema.len() > 256 {
                        return Err("Snowflake schema name is too long".to_string());
                    }
                }

                if let Some(role) = self
                    .additional_fields
                    .get("role")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if role.len() > 256 {
                        return Err("Snowflake role name is too long".to_string());
                    }
                }

                if let Some(port) = self.port {
                    if port == 0 {
                        return Err("Port cannot be zero".to_string());
                    }
                }
            }
            DatabaseType::BigQuery => {
                let project_id = self
                    .additional_fields
                    .get("project_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "BigQuery project ID is required".to_string())?;
                if project_id.len() > 128 {
                    return Err("BigQuery project ID is too long".to_string());
                }

                if let Some(dataset) = self
                    .additional_fields
                    .get("dataset")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if dataset.len() > 256 {
                        return Err("BigQuery dataset is too long".to_string());
                    }
                }

                if let Some(location) = self
                    .additional_fields
                    .get("location")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if location.len() > 64 {
                        return Err("BigQuery location is too long".to_string());
                    }
                }

                let token = self
                    .password
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "BigQuery access token is required".to_string())?;
                if token.len() > 8192 {
                    return Err("BigQuery access token is too long".to_string());
                }

                if let Some(host) = self
                    .host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    validate_network_host(host)?;
                }
            }
            _ => {
                // For network databases, host is required
                if let Some(ref host) = self.host {
                    validate_network_host(host)?;
                } else {
                    return Err("Host is required for this database type".to_string());
                }

                if self
                    .username
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                    && database_requires_username(self.db_type)
                {
                    return Err("Username is required for this database type".to_string());
                }

                // Validate port if provided
                if let Some(port) = self.port {
                    if port == 0 {
                        return Err("Port cannot be zero".to_string());
                    }
                }
            }
        }

        Ok(())
    }
}

fn database_requires_username(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::MySQL
            | DatabaseType::MariaDB
            | DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::Cassandra
            | DatabaseType::MSSQL
            | DatabaseType::Vertica
            | DatabaseType::ClickHouse
    )
}

fn validate_network_host(host: &str) -> Result<(), String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Host cannot be empty".to_string());
    }

    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("Host contains invalid whitespace or control characters".to_string());
    }

    if trimmed.contains("://")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('?')
        || trimmed.contains('#')
    {
        return Err("Host must not include a scheme, path, query, or fragment".to_string());
    }

    Ok(())
}

fn validate_local_file_path(
    path: &str,
    allowed_extensions: &[&str],
    empty_message: &str,
    engine_label: &str,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{empty_message} cannot be empty"));
    }

    if trimmed == ":memory:" {
        return Ok(());
    }

    if trimmed
        .chars()
        .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(format!(
            "{engine_label} file path contains invalid control characters"
        ));
    }

    if trimmed.starts_with("\\\\") {
        return Err(format!(
            "{engine_label} file paths cannot use remote UNC locations"
        ));
    }

    let colon_positions = trimmed
        .match_indices(':')
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if colon_positions.len() > 1 || colon_positions.iter().any(|index| *index > 1) {
        return Err(format!(
            "{engine_label} file paths cannot use URI-style or alternate data stream suffixes"
        ));
    }

    let local_path = Path::new(trimmed);
    if local_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "{engine_label} file path cannot contain parent directory traversal segments"
        ));
    }

    let extension = local_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());

    if !matches!(extension.as_deref(), Some(ext) if allowed_extensions.contains(&ext)) {
        let formatted_extensions = allowed_extensions
            .iter()
            .map(|ext| format!(".{ext}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "{engine_label} file path must use one of these extensions: {formatted_extensions}"
        ));
    }

    let resolved_path = if local_path.is_absolute() {
        local_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "Could not resolve the current working directory".to_string())?
            .join(local_path)
    };

    for ancestor in resolved_path.ancestors() {
        if !ancestor.exists() {
            continue;
        }

        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| format!("Could not inspect the selected {engine_label} file path"))?;

        if metadata.file_type().is_symlink() {
            return Err(format!("{engine_label} symlink targets are not allowed"));
        }
    }

    if local_path.exists() {
        let metadata = fs::symlink_metadata(local_path)
            .map_err(|_| format!("Could not inspect the selected {engine_label} file path"))?;

        if metadata.file_type().is_symlink() {
            return Err(format!("{engine_label} symlink targets are not allowed"));
        }

        if metadata.is_dir() {
            return Err(format!(
                "{engine_label} file path must point to a file, not a directory"
            ));
        }
    }

    if let Some(parent_dir) = resolved_path.parent() {
        if parent_dir.exists() && !parent_dir.is_dir() {
            return Err(format!(
                "{engine_label} file path must use a valid parent directory"
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::connection::{ConnectionConfig, DatabaseType};
    use std::collections::HashMap;

    #[test]
    fn allows_redis_validation_without_username() {
        let config = ConnectionConfig {
            id: "redis-test".to_string(),
            name: "Redis test".to_string(),
            db_type: DatabaseType::Redis,
            host: Some("127.0.0.1".to_string()),
            port: Some(6379),
            username: Some(String::new()),
            password: None,
            database: None,
            file_path: None,
            use_ssl: false,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: HashMap::new(),
            startup_commands: None,
            pre_connect_script: None,
            ssh_config: None,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn validates_snowflake_requirements_without_username() {
        let mut additional_fields = HashMap::new();
        additional_fields.insert("warehouse".to_string(), "COMPUTE_WH".to_string());
        additional_fields.insert("schema".to_string(), "PUBLIC".to_string());
        additional_fields.insert("role".to_string(), "SYSADMIN".to_string());

        let config = ConnectionConfig {
            id: "snowflake-test".to_string(),
            name: "Snowflake".to_string(),
            db_type: DatabaseType::Snowflake,
            host: Some("acme.us-east-1.snowflakecomputing.com".to_string()),
            port: Some(443),
            username: None,
            password: Some("example-snowflake-credential".to_string()),
            database: Some("analytics".to_string()),
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields,
            startup_commands: None,
            pre_connect_script: None,
            ssh_config: None,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn validates_cloudflare_d1_requirements() {
        let mut additional_fields = HashMap::new();
        additional_fields.insert("account_id".to_string(), "acct_123".to_string());
        additional_fields.insert("database_id".to_string(), "db_123".to_string());

        let config = ConnectionConfig {
            id: "d1-test".to_string(),
            name: "Cloudflare D1".to_string(),
            db_type: DatabaseType::CloudflareD1,
            host: Some("api.cloudflare.com".to_string()),
            port: Some(443),
            username: None,
            password: Some("example-cloudflare-credential".to_string()),
            database: None,
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields,
            startup_commands: None,
            pre_connect_script: None,
            ssh_config: None,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn validates_bigquery_requirements() {
        let mut additional_fields = HashMap::new();
        additional_fields.insert("project_id".to_string(), "analytics-project".to_string());
        additional_fields.insert("dataset".to_string(), "events".to_string());
        additional_fields.insert("location".to_string(), "us-central1".to_string());

        let config = ConnectionConfig {
            id: "bigquery-test".to_string(),
            name: "BigQuery".to_string(),
            db_type: DatabaseType::BigQuery,
            host: Some("bigquery.googleapis.com".to_string()),
            port: Some(443),
            username: None,
            password: Some("example-bigquery-credential".to_string()),
            database: None,
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields,
            startup_commands: None,
            pre_connect_script: None,
            ssh_config: None,
        };

        assert!(config.validate().is_ok());
    }
}