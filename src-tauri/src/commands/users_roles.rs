use crate::commands::safe_mode::SafeModeState;
use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use crate::database::opensearch::OpenSearchDriver;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRolePrincipal {
    pub id: String,
    pub name: String,
    pub host: Option<String>,
    pub can_login: bool,
    pub is_superuser: bool,
    pub roles: Vec<String>,
    pub direct_privileges: Vec<String>,
    pub effective_privileges: Vec<String>,
    pub privileges: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleSnapshot {
    pub engine: String,
    pub principals: Vec<UserRolePrincipal>,
    /// True when the privilege/membership catalog queries FAILED (as opposed
    /// to returning zero rows): the UI must not render "no privileges" for a
    /// principal whose grants simply could not be read.
    pub privileges_unavailable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UserRoleChangeAction {
    CreateUser,
    GrantRole,
    RevokeRole,
    GrantPrivilege,
    RevokePrivilege,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleChangeRequest {
    pub action: UserRoleChangeAction,
    pub user_name: String,
    pub host: Option<String>,
    pub role_name: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub privilege: Option<String>,
    #[serde(default)]
    pub object_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleChangeReview {
    pub engine: String,
    pub statements: Vec<String>,
    pub confirmation_phrase: String,
}

const APPLY_CONFIRMATION: &str = "APPLY USER ROLE CHANGE";

#[tauri::command]
pub async fn get_user_role_snapshot(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<UserRoleSnapshot, String> {
    // The engine key comes from the capability profile, not `driver_name()`:
    // driver_name is a display label ("PostgreSQL", "Snowflake") and shared
    // wire drivers (PostgresDriver serving Redshift/Vertica/CockroachDB) all
    // report the same label, so it cannot select a dialect.
    let profile = db_manager
        .get_connection_capabilities(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    profile.require(DriverCapability::Administration)?;
    let engine = profile.key.to_string();
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    match engine.as_str() {
        "postgresql" | "greenplum" | "cockroachdb" => {
            let result = driver
                .execute_query(POSTGRES_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            // A failed privilege read is NOT "no privileges": surface the
            // failure so the UI can say the grant list is unavailable
            // instead of showing every principal as privilege-less.
            let privileges = driver
                .execute_query(POSTGRES_PRIVILEGES_SQL)
                .await
                .map_err(|error| {
                    log::warn!("user/role privilege query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: postgres_principals(result, privileges.clone()),
                privileges_unavailable: privileges.is_none(),
            })
        }
        "mysql" | "mariadb" => {
            let users = driver
                .execute_query(MYSQL_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let privileges = driver
                .execute_query(MYSQL_PRIVILEGES_SQL)
                .await
                .map_err(|error| {
                    log::warn!("user/role privilege query failed: {error}");
                    error.to_string()
                })
                .ok();
            let role_memberships = driver
                .execute_query(if engine == "mariadb" {
                    MARIADB_ROLE_MEMBERSHIPS_SQL
                } else {
                    MYSQL_ROLE_MEMBERSHIPS_SQL
                })
                .await
                .map_err(|error| {
                    log::warn!("user/role membership query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: mysql_principals(users, privileges.clone(), role_memberships.clone()),
                privileges_unavailable: privileges.is_none() || role_memberships.is_none(),
            })
        }
        "mssql" => {
            let principals = driver
                .execute_query(MSSQL_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let privileges = driver
                .execute_query(MSSQL_PRIVILEGES_SQL)
                .await
                .map_err(|error| {
                    log::warn!("mssql privilege query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: mssql_principals(principals, privileges.clone()),
                privileges_unavailable: privileges.is_none(),
            })
        }
        "redshift" => {
            let result = driver
                .execute_query(REDSHIFT_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let privileges = driver
                .execute_query(REDSHIFT_PRIVILEGES_SQL)
                .await
                .map_err(|error| {
                    log::warn!("redshift privilege query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: postgres_principals(result, privileges.clone()),
                privileges_unavailable: privileges.is_none(),
            })
        }
        "vertica" => {
            let result = driver
                .execute_query(VERTICA_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let privileges = driver
                .execute_query(VERTICA_PRIVILEGES_SQL)
                .await
                .map_err(|error| {
                    log::warn!("vertica privilege query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: postgres_principals(result, privileges.clone()),
                privileges_unavailable: privileges.is_none(),
            })
        }
        "snowflake" => {
            let users = driver
                .execute_query(SNOWFLAKE_USERS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            // SHOW GRANTS TO USER runs once per principal — Snowflake has no
            // single catalog listing every user's grants without
            // ACCOUNT_USAGE privileges. One failure marks the whole grant
            // list unavailable rather than showing partial data.
            let grants = snowflake_grants(driver.as_ref(), &users).await;
            Ok(UserRoleSnapshot {
                engine,
                principals: snowflake_principals(users, grants.as_ref()),
                privileges_unavailable: grants.is_none(),
            })
        }
        "clickhouse" => {
            let users = driver
                .execute_query(CLICKHOUSE_USERS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let grants = driver
                .execute_query(CLICKHOUSE_GRANTS_SQL)
                .await
                .map_err(|error| {
                    log::warn!("clickhouse privilege query failed: {error}");
                    error.to_string()
                })
                .ok();
            let role_grants = driver
                .execute_query(CLICKHOUSE_ROLE_GRANTS_SQL)
                .await
                .map_err(|error| {
                    log::warn!("clickhouse role grant query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: clickhouse_principals(
                    users,
                    grants.as_ref(),
                    role_grants.as_ref(),
                ),
                privileges_unavailable: grants.is_none() || role_grants.is_none(),
            })
        }
        "cassandra" => {
            let roles = driver
                .execute_query(CASSANDRA_ROLES_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let permissions = driver
                .execute_query(CASSANDRA_PERMISSIONS_SQL)
                .await
                .map_err(|error| {
                    log::warn!("cassandra permission query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: cassandra_principals(roles, permissions.as_ref()),
                privileges_unavailable: permissions.is_none(),
            })
        }
        "mongodb" => {
            let users = mongodb_users(driver.as_ref()).await?;
            Ok(UserRoleSnapshot {
                engine,
                principals: mongodb_principals(users),
                privileges_unavailable: false,
            })
        }
        "redis" => {
            let acl = driver
                .execute_query(REDIS_ACL_LIST_CMD)
                .await
                .map_err(|error| error.to_string())?;
            Ok(UserRoleSnapshot {
                engine,
                principals: redis_principals(acl),
                privileges_unavailable: false,
            })
        }
        "opensearch" => {
            let opensearch = driver
                .as_any()
                .and_then(|any| any.downcast_ref::<OpenSearchDriver>())
                .ok_or_else(|| {
                    "OpenSearch administration requires the native OpenSearch driver."
                        .to_string()
                })?;
            let users = opensearch
                .security_api_request(
                    Method::GET,
                    "/_plugins/_security/api/internalusers",
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            let role_mappings = opensearch
                .security_api_request(
                    Method::GET,
                    "/_plugins/_security/api/rolesmapping",
                    None,
                )
                .await
                .map_err(|error| {
                    log::warn!("opensearch rolesmapping query failed: {error}");
                    error.to_string()
                })
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: opensearch_principals(&users, role_mappings.as_ref()),
                privileges_unavailable: role_mappings.is_none(),
            })
        }
        _ => Err(
            "Users & Roles is currently available for PostgreSQL, CockroachDB, Redshift, Vertica, MySQL, MariaDB, SQL Server, Snowflake, ClickHouse, Cassandra, MongoDB, Redis, and OpenSearch."
                .to_string(),
        ),
    }
}

#[tauri::command]
pub async fn review_user_role_change(
    connection_id: String,
    request: UserRoleChangeRequest,
    db_manager: State<'_, DatabaseManager>,
) -> Result<UserRoleChangeReview, String> {
    let profile = db_manager
        .get_connection_capabilities(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    profile.require(DriverCapability::Administration)?;
    build_review(profile.key, &request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_user_role_change(
    connection_id: String,
    request: UserRoleChangeRequest,
    confirmation_phrase: String,
    db_manager: State<'_, DatabaseManager>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<UserRoleSnapshot, String> {
    db_manager.assert_write_allowed(&connection_id).await?;
    if confirmation_phrase.trim() != APPLY_CONFIRMATION {
        return Err("Explicit confirmation phrase did not match.".to_string());
    }
    let profile = db_manager
        .get_connection_capabilities(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    profile.require(DriverCapability::Administration)?;
    let database_type = Some(profile.database_type);
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let statements =
        build_executable_statements(profile.key, &request).map_err(|error| error.to_string())?;
    // GRANT/REVOKE/CREATE USER bypass the SQL editor, so Safe Mode never saw
    // them — gate the real statements like every other mutation path.
    // OpenSearch's reviewed lines are REST descriptions, not SQL, so the
    // probe is an equivalent SQL-shaped statement the classifier understands.
    let probe = if profile.key == "opensearch" {
        opensearch_safe_mode_probe(&request)
    } else {
        statements.join(";\n")
    };
    safe_mode
        .ensure_mutation_allowed(&connection_id, &probe, database_type)
        .await?;
    if profile.key == "opensearch" {
        // OpenSearch administration is a REST API, not SQL — the reviewed
        // statements are descriptive only; the native driver call performs
        // the actual change.
        apply_opensearch_change(driver.as_ref(), &request).await?;
    } else {
        for statement in statements {
            driver
                .execute_query(&statement)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(get_user_role_snapshot(connection_id, db_manager).await?)
}

fn build_review(
    engine: &str,
    request: &UserRoleChangeRequest,
) -> Result<UserRoleChangeReview, String> {
    let mut statements = build_executable_statements(engine, request)?;
    if matches!(request.action, UserRoleChangeAction::CreateUser) && request.password.is_some() {
        statements = statements
            .into_iter()
            .map(|statement| redact_password_clause(&statement))
            .collect();
    }
    Ok(UserRoleChangeReview {
        engine: engine.to_string(),
        statements,
        confirmation_phrase: APPLY_CONFIRMATION.to_string(),
    })
}

fn build_executable_statements(
    engine: &str,
    request: &UserRoleChangeRequest,
) -> Result<Vec<String>, String> {
    let user_name = require_identifier(&request.user_name, "User name")?;
    let role_name = request
        .role_name
        .as_deref()
        .map(|value| require_identifier(value, "Role name"))
        .transpose()?;
    // Engines with non-SQL or differently-shaped admin surfaces dispatch to
    // their own builders BEFORE the shared privilege allowlist — Cassandra's
    // MODIFY/ALTER/DROP and ClickHouse's ALTER UPDATE would never pass the
    // SQL-92 list, and MongoDB/Redis/OpenSearch don't speak GRANT at all.
    match engine {
        "snowflake" => return snowflake_statements(request, user_name, role_name),
        "clickhouse" => return clickhouse_statements(request, user_name, role_name),
        "cassandra" => return cassandra_statements(request, user_name, role_name),
        "mongodb" => return mongodb_statements(request, user_name, role_name),
        "redis" => return redis_statements(request, user_name),
        "opensearch" => return opensearch_statements(request, user_name, role_name),
        _ => {}
    }
    let privilege = request
        .privilege
        .as_deref()
        .map(|value| require_privilege(value))
        .transpose()?;
    let is_postgres = matches!(
        engine,
        "postgresql" | "greenplum" | "cockroachdb" | "redshift" | "vertica"
    );
    let is_mysql = matches!(engine, "mysql" | "mariadb");
    let is_mssql = engine == "mssql";
    if !is_postgres && !is_mysql && !is_mssql {
        return Err(
            "Users & Roles is currently available for PostgreSQL, CockroachDB, Redshift, Vertica, MySQL, MariaDB, SQL Server, Snowflake, ClickHouse, Cassandra, MongoDB, Redis, and OpenSearch."
                .to_string(),
        );
    }
    let user = if is_postgres {
        quote_postgres_identifier(user_name)
    } else if is_mssql {
        quote_mssql_identifier(user_name)?
    } else {
        mysql_account(user_name, request.host.as_deref())?
    };
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            if is_postgres {
                let password = request
                    .password
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(quote_postgres_literal)
                    .map(|password| format!(" PASSWORD {password}"))
                    .unwrap_or_default();
                format!("CREATE ROLE {user} LOGIN{password};")
            } else if is_mssql {
                // SQL Server separates the server LOGIN from the database
                // USER — create both so the principal can actually connect.
                let password = request
                    .password
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(quote_mssql_literal)
                    .map(|password| format!(" WITH PASSWORD = {password}"))
                    .unwrap_or_default();
                format!("CREATE LOGIN {user}{password}; CREATE USER {user} FOR LOGIN {user};")
            } else {
                let password = request
                    .password
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(quote_mysql_literal)
                    .map(|password| format!(" IDENTIFIED BY {password}"))
                    .unwrap_or_default();
                format!("CREATE USER {user}{password};")
            }
        }
        UserRoleChangeAction::GrantRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            if is_mssql {
                // SQL Server role membership goes through ALTER ROLE, not
                // GRANT — GRANT assigns permissions, not membership.
                format!(
                    "ALTER ROLE {} ADD MEMBER {};",
                    quote_mssql_identifier(role)?,
                    user
                )
            } else {
                let role = if is_postgres {
                    quote_postgres_identifier(role)
                } else {
                    quote_mysql_identifier(role)
                };
                format!("GRANT {role} TO {user};")
            }
        }
        UserRoleChangeAction::RevokeRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            if is_mssql {
                format!(
                    "ALTER ROLE {} DROP MEMBER {};",
                    quote_mssql_identifier(role)?,
                    user
                )
            } else {
                let role = if is_postgres {
                    quote_postgres_identifier(role)
                } else {
                    quote_mysql_identifier(role)
                };
                format!("REVOKE {role} FROM {user};")
            }
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            let privilege = privilege.ok_or_else(|| "Privilege is required.".to_string())?;
            let object_name = request
                .object_name
                .as_deref()
                .ok_or_else(|| "Object name is required.".to_string())?;
            let object = quote_qualified_object(
                object_name,
                if is_postgres {
                    "postgres"
                } else if is_mssql {
                    "mssql"
                } else {
                    "mysql"
                },
            )?;
            let verb = if matches!(request.action, UserRoleChangeAction::GrantPrivilege) {
                "GRANT"
            } else {
                "REVOKE"
            };
            let direction = if verb == "GRANT" { "TO" } else { "FROM" };
            if is_postgres {
                format!("{verb} {privilege} ON TABLE {object} {direction} {user};")
            } else if is_mssql {
                // SQL Server qualifies objects as schema.object and uses
                // OBJECT:: for the grant target.
                format!("{verb} {privilege} ON OBJECT::{object} {direction} {user};")
            } else {
                format!("{verb} {privilege} ON {object} {direction} {user};")
            }
        }
    };
    Ok(vec![statement])
}

fn require_privilege(value: &str) -> Result<&str, String> {
    let normalized = value.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "REFERENCES" | "TRIGGER" => {
            Ok(match normalized.as_str() {
                "SELECT" => "SELECT",
                "INSERT" => "INSERT",
                "UPDATE" => "UPDATE",
                "DELETE" => "DELETE",
                "REFERENCES" => "REFERENCES",
                _ => "TRIGGER",
            })
        }
        _ => Err(
            "Privilege must be SELECT, INSERT, UPDATE, DELETE, REFERENCES, or TRIGGER.".to_string(),
        ),
    }
}

fn quote_qualified_object(value: &str, dialect: &str) -> Result<String, String> {
    let parts = value.split('.').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 {
        return Err("Object name must contain one to three qualified identifiers.".to_string());
    }
    parts
        .into_iter()
        .map(|part| {
            let identifier = require_identifier(part, "Object identifier")?;
            Ok(match dialect {
                "postgres" => quote_postgres_identifier(identifier),
                "mssql" => quote_mssql_identifier(identifier)?,
                _ => quote_mysql_identifier(identifier),
            })
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join("."))
}

fn require_identifier<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(format!(
            "{label} must be between 1 and 128 printable characters."
        ));
    }
    Ok(value)
}

fn quote_postgres_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn quote_postgres_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_mysql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn quote_mssql_identifier(value: &str) -> Result<String, String> {
    crate::database::safety::quote_mssql_identifier(value).map_err(|e| e.to_string())
}

fn quote_mssql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn mysql_account(user: &str, host: Option<&str>) -> Result<String, String> {
    let host = host.unwrap_or("%").trim();
    require_identifier(host, "Host")?;
    Ok(format!(
        "{}@{}",
        quote_mysql_literal(user),
        quote_mysql_literal(host)
    ))
}

fn redact_password_clause(statement: &str) -> String {
    if let Some((prefix, _)) = statement.split_once(" PASSWORD ") {
        return format!("{prefix} PASSWORD [REDACTED];");
    }
    if let Some((prefix, _)) = statement.split_once(" IDENTIFIED BY ") {
        return format!("{prefix} IDENTIFIED BY [REDACTED];");
    }
    // MongoDB createUser embeds the password inside a JSON command document.
    if let Some((prefix, _)) = statement.split_once(", pwd: ") {
        return format!("{prefix}, pwd: [REDACTED] }})");
    }
    statement.to_string()
}

fn postgres_principals(
    result: QueryResult,
    privileges: Option<QueryResult>,
) -> Vec<UserRolePrincipal> {
    let direct_privileges = build_privilege_map(privileges, false);
    let role_map = result
        .rows
        .iter()
        .map(|row| (row_string(row, 0), split_csv(&row_string(row, 3))))
        .collect::<HashMap<_, _>>();
    result
        .rows
        .into_iter()
        .map(|row| {
            let name = row_string(&row, 0);
            let direct = direct_privileges.get(&name).cloned().unwrap_or_default();
            let effective = collect_effective_privileges(&name, &direct_privileges, &role_map);
            UserRolePrincipal {
                id: name.clone(),
                name,
                host: None,
                can_login: row_bool(&row, 1),
                is_superuser: row_bool(&row, 2),
                roles: split_csv(&row_string(&row, 3)),
                direct_privileges: direct,
                privileges: effective.clone(),
                effective_privileges: effective,
            }
        })
        .collect()
}

fn mysql_principals(
    users: QueryResult,
    privileges: Option<QueryResult>,
    memberships: Option<QueryResult>,
) -> Vec<UserRolePrincipal> {
    let privilege_map = build_privilege_map(privileges, true);
    let mut role_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(memberships) = memberships {
        for row in memberships.rows {
            role_map
                .entry(normalize_mysql_grantee(&row_string(&row, 0)))
                .or_default()
                .push(row_string(&row, 1));
        }
    }
    users
        .rows
        .into_iter()
        .map(|row| {
            let name = row_string(&row, 0);
            let host = row_string(&row, 1);
            let id = format!("{name}@{host}");
            let direct = privilege_map.get(&id).cloned().unwrap_or_default();
            let effective = collect_effective_privileges(&id, &privilege_map, &role_map);
            UserRolePrincipal {
                id: id.clone(),
                name,
                host: Some(host),
                can_login: true,
                is_superuser: false,
                roles: role_map.get(&id).cloned().unwrap_or_default(),
                direct_privileges: direct,
                privileges: effective.clone(),
                effective_privileges: effective,
            }
        })
        .collect()
}

fn mssql_principals(
    result: QueryResult,
    privileges: Option<QueryResult>,
) -> Vec<UserRolePrincipal> {
    let direct_privileges = build_privilege_map(privileges, false);
    let role_map = result
        .rows
        .iter()
        .map(|row| (row_string(row, 0), split_csv(&row_string(row, 3))))
        .collect::<HashMap<_, _>>();
    result
        .rows
        .into_iter()
        .map(|row| {
            let name = row_string(&row, 0);
            let direct = direct_privileges.get(&name).cloned().unwrap_or_default();
            let effective = collect_effective_privileges(&name, &direct_privileges, &role_map);
            UserRolePrincipal {
                id: name.clone(),
                name,
                host: None,
                can_login: row_bool(&row, 1),
                is_superuser: row_bool(&row, 2),
                roles: split_csv(&row_string(&row, 3)),
                direct_privileges: direct,
                privileges: effective.clone(),
                effective_privileges: effective,
            }
        })
        .collect()
}

fn build_privilege_map(
    result: Option<QueryResult>,
    normalize_mysql: bool,
) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(result) = result {
        for row in result.rows {
            let raw_grantee = row_string(&row, 0);
            let grantee = if normalize_mysql {
                normalize_mysql_grantee(&raw_grantee)
            } else {
                raw_grantee
            };
            map.entry(grantee).or_default().push(row_string(&row, 1));
        }
    }
    for values in map.values_mut() {
        values.sort();
        values.dedup();
    }
    map
}

fn collect_effective_privileges(
    principal: &str,
    direct: &HashMap<String, Vec<String>>,
    roles: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    fn visit(
        principal: &str,
        direct: &HashMap<String, Vec<String>>,
        roles: &HashMap<String, Vec<String>>,
        visited: &mut std::collections::HashSet<String>,
        output: &mut Vec<String>,
    ) {
        if !visited.insert(principal.to_string()) {
            return;
        }
        if let Some(privileges) = direct.get(principal) {
            output.extend(privileges.iter().cloned());
        }
        if let Some(memberships) = roles.get(principal) {
            for role in memberships {
                visit(role, direct, roles, visited, output);
            }
        }
    }

    let mut output = Vec::new();
    visit(
        principal,
        direct,
        roles,
        &mut std::collections::HashSet::new(),
        &mut output,
    );
    output.sort();
    output.dedup();
    output
}

fn row_string(row: &[serde_json::Value], index: usize) -> String {
    row.get(index)
        .and_then(|value| value.as_str().map(ToString::to_string))
        .or_else(|| row.get(index).map(ToString::to_string))
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

fn row_bool(row: &[serde_json::Value], index: usize) -> bool {
    row.get(index)
        .and_then(|value| value.as_bool())
        .unwrap_or_else(|| row_string(row, index).eq_ignore_ascii_case("true"))
}

fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

const MSSQL_PRINCIPALS_SQL: &str = "SELECT p.name AS user_name, CASE WHEN p.type_desc IN ('SQL_LOGIN','WINDOWS_LOGIN','WINDOWS_GROUP') THEN 1 ELSE 0 END AS can_login, CASE WHEN p.name = 'sa' OR IS_SRVROLEMEMBER('sysadmin', p.name) = 1 THEN 1 ELSE 0 END AS is_superuser, COALESCE((SELECT STRING_AGG(r.name, ',') FROM sys.database_role_members drm JOIN sys.database_principals r ON r.principal_id = drm.role_principal_id JOIN sys.database_principals dp ON dp.principal_id = drm.member_principal_id WHERE dp.name = p.name), '') AS roles FROM sys.server_principals p WHERE p.type_desc IN ('SQL_LOGIN','WINDOWS_LOGIN','WINDOWS_GROUP','CERTIFICATE_MAPPED_LOGIN') AND p.name NOT LIKE '##%' ORDER BY p.name";
const MSSQL_PRIVILEGES_SQL: &str = "SELECT grantee.name AS grantee, SCHEMA_NAME(o.schema_id) + '.' + o.name + ':' + perm.permission_name AS privilege FROM sys.database_permissions perm JOIN sys.objects o ON o.object_id = perm.major_id JOIN sys.database_principals grantee ON grantee.principal_id = perm.grantee_principal_id WHERE perm.class = 1 ORDER BY grantee.name, privilege";

fn normalize_mysql_grantee(value: &str) -> String {
    value
        .trim()
        .trim_matches('\'')
        .replace("'@'", "@")
        .replace("''", "'")
}

const POSTGRES_PRINCIPALS_SQL: &str = "SELECT r.rolname AS user_name, r.rolcanlogin AS can_login, r.rolsuper AS is_superuser, COALESCE(string_agg(DISTINCT parent.rolname, ','), '') AS roles FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member = r.oid LEFT JOIN pg_roles parent ON parent.oid = m.roleid GROUP BY r.rolname, r.rolcanlogin, r.rolsuper ORDER BY r.rolname";
const POSTGRES_PRIVILEGES_SQL: &str = "SELECT grantee, table_schema || '.' || table_name || ':' || privilege_type AS privilege FROM information_schema.role_table_grants ORDER BY grantee, table_schema, table_name, privilege_type";
const MYSQL_PRINCIPALS_SQL: &str = "SELECT User AS user_name, Host AS host_name FROM mysql.user WHERE User <> '' ORDER BY User, Host";
const MYSQL_PRIVILEGES_SQL: &str = "SELECT GRANTEE, PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE, PRIVILEGE_TYPE";
const MYSQL_ROLE_MEMBERSHIPS_SQL: &str = "SELECT CONCAT(TO_USER, '@', TO_HOST) AS grantee, CONCAT(FROM_USER, '@', FROM_HOST) AS role_name FROM mysql.role_edges ORDER BY TO_USER, TO_HOST, FROM_USER, FROM_HOST";
const MARIADB_ROLE_MEMBERSHIPS_SQL: &str = "SELECT CONCAT(User, '@', Host) AS grantee, Role AS role_name FROM mysql.roles_mapping ORDER BY User, Host, Role";

// Redshift exposes users via pg_user (not pg_roles) and group membership via
// pg_group — pg_auth_members does not exist on Redshift.
const REDSHIFT_PRINCIPALS_SQL: &str = "SELECT u.usename AS user_name, u.usecreatedb AS can_login, u.usesuper AS is_superuser, COALESCE((SELECT string_agg(g.groname, ',') FROM pg_group g WHERE u.usesysid = ANY(g.grolist)), '') AS roles FROM pg_user u ORDER BY u.usename";
const REDSHIFT_PRIVILEGES_SQL: &str = "SELECT grantee, table_schema || '.' || table_name || ':' || privilege_type AS privilege FROM information_schema.role_table_grants ORDER BY grantee, table_schema, table_name, privilege_type";

// Snowflake exposes principals via SHOW USERS; per-user grants come from
// SHOW GRANTS TO USER (there is no single catalog of user grants without
// SNOWFLAKE.ACCOUNT_USAGE privileges).
const SNOWFLAKE_USERS_SQL: &str = "SHOW USERS";

// ClickHouse keeps principals in system.users, direct grants in
// system.grants, and role membership in system.role_grants.
const CLICKHOUSE_USERS_SQL: &str =
    "SELECT name, auth_type, host_ip FROM system.users ORDER BY name";
const CLICKHOUSE_GRANTS_SQL: &str = "SELECT * FROM system.grants";
const CLICKHOUSE_ROLE_GRANTS_SQL: &str = "SELECT * FROM system.role_grants";

// Cassandra stores roles (users are roles with login) in system_auth.roles
// and permissions in system_auth.role_permissions.
const CASSANDRA_ROLES_SQL: &str =
    "SELECT role, can_login, is_superuser, member_of FROM system_auth.roles";
const CASSANDRA_PERMISSIONS_SQL: &str =
    "SELECT role, resource, permissions FROM system_auth.role_permissions";

// Redis principals come from ACL LIST — one rule string per user.
const REDIS_ACL_LIST_CMD: &str = "ACL LIST";

fn column_index(result: &QueryResult, name: &str) -> Option<usize> {
    result
        .columns
        .iter()
        .position(|column| column.name.eq_ignore_ascii_case(name))
}

fn row_string_named(row: &[serde_json::Value], index: Option<usize>) -> String {
    index
        .map(|index| row_string(row, index))
        .unwrap_or_default()
}

fn row_bool_named(row: &[serde_json::Value], index: Option<usize>) -> bool {
    index.map(|index| row_bool(row, index)).unwrap_or(false)
}

/// Reads a cell that may be a JSON array (Cassandra `set<text>`, ClickHouse
/// `Array(String)`) or a scalar into a list of strings.
fn cell_string_list(row: &[serde_json::Value], index: Option<usize>) -> Vec<String> {
    let Some(index) = index else {
        return Vec::new();
    };
    match row.get(index) {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| item.to_string().trim_matches('"').to_string())
            })
            .filter(|item| !item.is_empty())
            .collect(),
        Some(JsonValue::Null) | None => Vec::new(),
        Some(other) => {
            let rendered = other
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| other.to_string());
            // Drivers may render sets as "{a, b}" — strip the braces.
            let trimmed = rendered
                .trim()
                .trim_start_matches('{')
                .trim_end_matches('}')
                .trim_start_matches('[')
                .trim_end_matches(']');
            split_csv(trimmed)
        }
    }
}

struct SnowflakeUserGrants {
    roles: Vec<String>,
    privileges: Vec<String>,
}

async fn snowflake_grants(
    driver: &dyn crate::database::driver::DatabaseDriver,
    users: &QueryResult,
) -> Option<HashMap<String, SnowflakeUserGrants>> {
    let name_index = column_index(users, "name")?;
    let mut grants = HashMap::new();
    for row in &users.rows {
        let name = row_string(row, name_index);
        if name.is_empty() {
            continue;
        }
        let statement = format!("SHOW GRANTS TO USER {}", quote_postgres_identifier(&name));
        let result = match driver.execute_query(&statement).await {
            Ok(result) => result,
            Err(error) => {
                log::warn!("snowflake grant query failed for {name}: {error}");
                return None;
            }
        };
        let privilege_index = column_index(&result, "privilege");
        let granted_on_index = column_index(&result, "granted_on");
        let object_index = column_index(&result, "name");
        let entry = grants.entry(name).or_insert(SnowflakeUserGrants {
            roles: Vec::new(),
            privileges: Vec::new(),
        });
        for grant_row in &result.rows {
            let privilege = row_string_named(grant_row, privilege_index);
            let granted_on = row_string_named(grant_row, granted_on_index);
            let object = row_string_named(grant_row, object_index);
            // granted_on = ROLE rows are role memberships, not privileges.
            if granted_on.eq_ignore_ascii_case("ROLE") {
                if !object.is_empty() {
                    entry.roles.push(object);
                }
            } else if !privilege.is_empty() {
                entry.privileges.push(format!("{object}:{privilege}"));
            }
        }
    }
    Some(grants)
}

fn snowflake_principals(
    users: QueryResult,
    grants: Option<&HashMap<String, SnowflakeUserGrants>>,
) -> Vec<UserRolePrincipal> {
    let name_index = column_index(&users, "name");
    let disabled_index = column_index(&users, "disabled");
    let default_role_index = column_index(&users, "default_role");
    users
        .rows
        .iter()
        .map(|row| {
            let name = row_string_named(row, name_index);
            let mut roles = Vec::new();
            let mut privileges = Vec::new();
            if let Some(entry) = grants.and_then(|grants| grants.get(&name)) {
                roles = entry.roles.clone();
                privileges = entry.privileges.clone();
            }
            let default_role = row_string_named(row, default_role_index);
            if !default_role.is_empty() && !roles.iter().any(|role| role == &default_role) {
                roles.push(default_role);
            }
            roles.sort();
            roles.dedup();
            privileges.sort();
            privileges.dedup();
            let is_superuser = roles
                .iter()
                .any(|role| role.eq_ignore_ascii_case("ACCOUNTADMIN"));
            UserRolePrincipal {
                id: name.clone(),
                name,
                host: None,
                can_login: !row_bool_named(row, disabled_index),
                is_superuser,
                roles,
                direct_privileges: privileges.clone(),
                effective_privileges: privileges.clone(),
                privileges,
            }
        })
        .collect()
}

fn clickhouse_principals(
    users: QueryResult,
    grants: Option<&QueryResult>,
    role_grants: Option<&QueryResult>,
) -> Vec<UserRolePrincipal> {
    let name_index = column_index(&users, "name");
    let host_ip_index = column_index(&users, "host_ip");

    let mut privileges: HashMap<String, Vec<String>> = HashMap::new();
    let mut superusers: HashMap<String, bool> = HashMap::new();
    if let Some(grants) = grants {
        let grant_user = column_index(grants, "user_name");
        let grant_access = column_index(grants, "access_type");
        let grant_db = column_index(grants, "database");
        let grant_table = column_index(grants, "table");
        for row in &grants.rows {
            let user = row_string_named(row, grant_user);
            if user.is_empty() {
                continue;
            }
            let access = row_string_named(row, grant_access);
            let database = row_string_named(row, grant_db);
            let table = row_string_named(row, grant_table);
            if access.eq_ignore_ascii_case("ALL")
                || access.eq_ignore_ascii_case("ACCESS MANAGEMENT")
            {
                superusers.insert(user.clone(), true);
            }
            let object = match (database.is_empty(), table.is_empty()) {
                (true, true) => "*".to_string(),
                (false, true) => format!("{database}.*"),
                _ => format!("{database}.{table}"),
            };
            privileges
                .entry(user)
                .or_default()
                .push(format!("{object}:{access}"));
        }
    }

    let mut memberships: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(role_grants) = role_grants {
        let grant_user = column_index(role_grants, "user_name");
        let grant_role = column_index(role_grants, "granted_role_name");
        for row in &role_grants.rows {
            let user = row_string_named(row, grant_user);
            let role = row_string_named(row, grant_role);
            if !user.is_empty() && !role.is_empty() {
                memberships.entry(user).or_default().push(role);
            }
        }
    }

    users
        .rows
        .iter()
        .map(|row| {
            let name = row_string_named(row, name_index);
            let hosts = cell_string_list(row, host_ip_index);
            let mut roles = memberships.get(&name).cloned().unwrap_or_default();
            roles.sort();
            roles.dedup();
            let mut direct = privileges.get(&name).cloned().unwrap_or_default();
            direct.sort();
            direct.dedup();
            UserRolePrincipal {
                id: name.clone(),
                name: name.clone(),
                host: if hosts.is_empty() {
                    None
                } else {
                    Some(hosts.join(","))
                },
                // ClickHouse users can always authenticate; host rules only
                // restrict the source address.
                can_login: true,
                is_superuser: superusers.get(&name).copied().unwrap_or(false),
                roles,
                direct_privileges: direct.clone(),
                effective_privileges: direct.clone(),
                privileges: direct,
            }
        })
        .collect()
}

fn cassandra_principals(
    roles: QueryResult,
    permissions: Option<&QueryResult>,
) -> Vec<UserRolePrincipal> {
    let role_index = column_index(&roles, "role");
    let login_index = column_index(&roles, "can_login");
    let super_index = column_index(&roles, "is_superuser");
    let member_index = column_index(&roles, "member_of");

    let mut privilege_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(permissions) = permissions {
        let perm_role = column_index(permissions, "role");
        let perm_resource = column_index(permissions, "resource");
        let perm_list = column_index(permissions, "permissions");
        for row in &permissions.rows {
            let role = row_string_named(row, perm_role);
            if role.is_empty() {
                continue;
            }
            let resource = row_string_named(row, perm_resource);
            for permission in cell_string_list(row, perm_list) {
                privilege_map
                    .entry(role.clone())
                    .or_default()
                    .push(format!("{resource}:{permission}"));
            }
        }
    }

    roles
        .rows
        .iter()
        .map(|row| {
            let name = row_string_named(row, role_index);
            let mut member_of = cell_string_list(row, member_index);
            member_of.sort();
            member_of.dedup();
            let mut direct = privilege_map.get(&name).cloned().unwrap_or_default();
            direct.sort();
            direct.dedup();
            UserRolePrincipal {
                id: name.clone(),
                name,
                host: None,
                can_login: row_bool_named(row, login_index),
                is_superuser: row_bool_named(row, super_index),
                roles: member_of,
                direct_privileges: direct.clone(),
                effective_privileges: direct.clone(),
                privileges: direct,
            }
        })
        .collect()
}

/// MongoDB users live in `admin.system.users`; the driver's command surface
/// only runs against the current database, so switch to `admin`, read
/// `system.users`, and restore the session database afterwards. When the
/// switch fails (restricted deployments), fall back to the current
/// database's `system.users` — that still lists users scoped to it.
async fn mongodb_users(
    driver: &dyn crate::database::driver::DatabaseDriver,
) -> Result<QueryResult, String> {
    const USERS_QUERY: &str = "db.system.users.find({})";
    let previous = driver.current_database();
    let mut switched = false;
    if previous.as_deref() != Some("admin") {
        switched = driver.use_database("admin").await.is_ok();
    }
    let result = driver.execute_query(USERS_QUERY).await;
    if switched {
        if let Some(previous) = previous.as_deref() {
            if let Err(error) = driver.use_database(previous).await {
                log::warn!("failed to restore MongoDB database {previous}: {error}");
            }
        }
    }
    match result {
        Ok(result) => Ok(result),
        Err(error) if switched => {
            log::warn!("admin.system.users read failed, retrying current database: {error}");
            driver
                .execute_query(USERS_QUERY)
                .await
                .map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn mongodb_principals(users: QueryResult) -> Vec<UserRolePrincipal> {
    let id_index = column_index(&users, "_id");
    let user_index = column_index(&users, "user");
    let db_index = column_index(&users, "db");
    let roles_index = column_index(&users, "roles");
    users
        .rows
        .iter()
        .map(|row| {
            let id = row_string_named(row, id_index);
            let name = {
                let user = row_string_named(row, user_index);
                if user.is_empty() {
                    // system.users._id is "<db>.<user>".
                    id.rsplit('.').next().unwrap_or(&id).to_string()
                } else {
                    user
                }
            };
            let roles = parse_mongodb_roles(row, roles_index);
            let is_superuser = roles
                .iter()
                .any(|role| role == "root" || role == "__system" || role.starts_with("root@"));
            UserRolePrincipal {
                id: if id.is_empty() { name.clone() } else { id },
                name,
                host: {
                    let db = row_string_named(row, db_index);
                    if db.is_empty() {
                        None
                    } else {
                        Some(db)
                    }
                },
                can_login: true,
                is_superuser,
                roles,
                // MongoDB has no direct privileges — access is granted only
                // through roles, which the roles column already shows.
                direct_privileges: Vec::new(),
                effective_privileges: Vec::new(),
                privileges: Vec::new(),
            }
        })
        .collect()
}

/// The `roles` cell is a JSON string like
/// `[{"role":"read","db":"app"}]` rendered by the driver's grid conversion.
fn parse_mongodb_roles(row: &[serde_json::Value], index: Option<usize>) -> Vec<String> {
    let Some(index) = index else {
        return Vec::new();
    };
    let raw = match row.get(index) {
        Some(JsonValue::String(value)) => value.clone(),
        Some(other) => other.to_string(),
        None => return Vec::new(),
    };
    let parsed: JsonValue = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    parsed
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let role = entry.get("role")?.as_str()?;
                    let db = entry.get("db").and_then(|db| db.as_str());
                    Some(match db {
                        Some(db) if !db.is_empty() => format!("{role}@{db}"),
                        _ => role.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// ACL LIST returns one rule string per user:
/// `user <name> on|off nopass|#hash ~patterns &channels +commands`.
fn redis_principals(acl: QueryResult) -> Vec<UserRolePrincipal> {
    acl.rows
        .iter()
        .filter_map(|row| {
            let rule = row_string(row, 0);
            let mut tokens = rule.split_whitespace();
            if tokens.next() != Some("user") {
                return None;
            }
            let name = tokens.next()?.to_string();
            let mut can_login = false;
            let mut privileges = Vec::new();
            for token in tokens {
                match token {
                    "on" => can_login = true,
                    "off" => can_login = false,
                    _ => {}
                }
                if token.starts_with('~')
                    || token.starts_with('&')
                    || token.starts_with('+')
                    || token.starts_with('-')
                    || token.starts_with('%')
                {
                    privileges.push(token.to_string());
                }
            }
            privileges.sort();
            privileges.dedup();
            let is_superuser = privileges.iter().any(|rule| rule == "+@all")
                && privileges.iter().any(|rule| rule == "~*");
            Some(UserRolePrincipal {
                id: name.clone(),
                name,
                host: None,
                can_login,
                is_superuser,
                roles: Vec::new(),
                direct_privileges: privileges.clone(),
                effective_privileges: privileges.clone(),
                privileges,
            })
        })
        .collect()
}

fn opensearch_principals(
    users: &JsonValue,
    role_mappings: Option<&JsonValue>,
) -> Vec<UserRolePrincipal> {
    // GET internalusers returns { "<name>": { "backend_roles": [...], ... } }.
    // GET rolesmapping returns { "<role>": { "users": [...], "backend_roles": [...] } }.
    let mut memberships: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(JsonValue::Object(mappings)) = role_mappings {
        for (role, mapping) in mappings {
            if let Some(users) = mapping.get("users").and_then(|users| users.as_array()) {
                for user in users.iter().filter_map(|user| user.as_str()) {
                    memberships
                        .entry(user.to_string())
                        .or_default()
                        .push(role.clone());
                }
            }
        }
    }
    users
        .as_object()
        .map(|entries| {
            entries
                .iter()
                .map(|(name, entry)| {
                    let mut roles = memberships.get(name).cloned().unwrap_or_default();
                    if let Some(backend_roles) = entry
                        .get("backend_roles")
                        .and_then(|roles| roles.as_array())
                    {
                        for role in backend_roles.iter().filter_map(|role| role.as_str()) {
                            roles.push(role.to_string());
                        }
                    }
                    roles.sort();
                    roles.dedup();
                    let is_superuser = roles
                        .iter()
                        .any(|role| role == "all_access" || role == "security_manager");
                    UserRolePrincipal {
                        id: name.clone(),
                        name: name.clone(),
                        host: None,
                        can_login: true,
                        is_superuser,
                        roles,
                        direct_privileges: Vec::new(),
                        effective_privileges: Vec::new(),
                        privileges: Vec::new(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn snowflake_statements(
    request: &UserRoleChangeRequest,
    user_name: &str,
    role_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let user = quote_postgres_identifier(user_name);
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            let password = request
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(quote_postgres_literal)
                .map(|password| format!(" PASSWORD = {password}"))
                .unwrap_or_default();
            format!("CREATE USER {user}{password};")
        }
        UserRoleChangeAction::GrantRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            format!(
                "GRANT ROLE {} TO USER {user};",
                quote_postgres_identifier(role)
            )
        }
        UserRoleChangeAction::RevokeRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            format!(
                "REVOKE ROLE {} FROM USER {user};",
                quote_postgres_identifier(role)
            )
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            let privilege = request
                .privilege
                .as_deref()
                .map(require_privilege)
                .transpose()?
                .ok_or_else(|| "Privilege is required.".to_string())?;
            let object_name = request
                .object_name
                .as_deref()
                .ok_or_else(|| "Object name is required.".to_string())?;
            let object = quote_qualified_object(object_name, "postgres")?;
            let verb = if matches!(request.action, UserRoleChangeAction::GrantPrivilege) {
                "GRANT"
            } else {
                "REVOKE"
            };
            let direction = if verb == "GRANT" { "TO" } else { "FROM" };
            format!("{verb} {privilege} ON TABLE {object} {direction} USER {user};")
        }
    };
    Ok(vec![statement])
}

fn clickhouse_statements(
    request: &UserRoleChangeRequest,
    user_name: &str,
    role_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let user = quote_mysql_identifier(user_name);
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            let password = request
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(quote_mysql_literal)
                .map(|password| format!(" IDENTIFIED BY {password}"))
                .unwrap_or_default();
            let host = request
                .host
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|host| {
                    require_identifier(host, "Host")
                        .map(|host| format!(" HOST IP {}", quote_mysql_literal(host)))
                })
                .transpose()?
                .unwrap_or_default();
            format!("CREATE USER {user}{host}{password};")
        }
        UserRoleChangeAction::GrantRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            format!("GRANT {} TO {user};", quote_mysql_identifier(role))
        }
        UserRoleChangeAction::RevokeRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            format!("REVOKE {} FROM {user};", quote_mysql_identifier(role))
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            let privilege = request
                .privilege
                .as_deref()
                .map(clickhouse_privilege)
                .transpose()?
                .ok_or_else(|| "Privilege is required.".to_string())?;
            let object_name = request
                .object_name
                .as_deref()
                .ok_or_else(|| "Object name is required.".to_string())?;
            // ClickHouse grant targets are unquoted db.table / db.* names.
            let object = clickhouse_grant_target(object_name)?;
            let verb = if matches!(request.action, UserRoleChangeAction::GrantPrivilege) {
                "GRANT"
            } else {
                "REVOKE"
            };
            let direction = if verb == "GRANT" { "TO" } else { "FROM" };
            format!("{verb} {privilege} ON {object} {direction} {user};")
        }
    };
    Ok(vec![statement])
}

fn clickhouse_privilege(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "SELECT" => Ok("SELECT"),
        "INSERT" => Ok("INSERT"),
        // ClickHouse mutations are ALTER privileges, not DML grants.
        "UPDATE" => Ok("ALTER UPDATE"),
        "DELETE" => Ok("ALTER DELETE"),
        _ => Err("ClickHouse privilege must be SELECT, INSERT, UPDATE, or DELETE.".to_string()),
    }
}

fn clickhouse_grant_target(value: &str) -> Result<String, String> {
    let parts = value.split('.').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 2 {
        return Err("ClickHouse grant target must be a table or database.table name.".to_string());
    }
    parts
        .into_iter()
        .map(|part| {
            if part == "*" {
                return Ok("*".to_string());
            }
            // Backtick-quoted like other ClickHouse identifiers — a bare name
            // containing spaces or quotes would inject into the GRANT.
            require_identifier(part, "Object identifier").map(quote_mysql_identifier)
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join("."))
}

fn cassandra_statements(
    request: &UserRoleChangeRequest,
    user_name: &str,
    role_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let user = quote_postgres_identifier(user_name);
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            // Cassandra users are roles with LOGIN; PASSWORD is required for
            // password authentication.
            let password = request
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(quote_postgres_literal)
                .map(|password| format!(" AND PASSWORD = {password}"))
                .unwrap_or_default();
            format!("CREATE ROLE {user} WITH LOGIN = true{password};")
        }
        UserRoleChangeAction::GrantRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            format!("GRANT {} TO {user};", quote_postgres_identifier(role))
        }
        UserRoleChangeAction::RevokeRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            format!("REVOKE {} FROM {user};", quote_postgres_identifier(role))
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            let permission = request
                .privilege
                .as_deref()
                .map(cassandra_permission)
                .transpose()?
                .ok_or_else(|| "Privilege is required.".to_string())?;
            let object_name = request
                .object_name
                .as_deref()
                .ok_or_else(|| "Object name is required.".to_string())?;
            if object_name.split('.').count() > 2 {
                return Err("Cassandra grant targets are keyspace.table names.".to_string());
            }
            let object = quote_qualified_object(object_name, "postgres")?;
            let verb = if matches!(request.action, UserRoleChangeAction::GrantPrivilege) {
                "GRANT"
            } else {
                "REVOKE"
            };
            let direction = if verb == "GRANT" { "TO" } else { "FROM" };
            format!("{verb} {permission} ON TABLE {object} {direction} {user};")
        }
    };
    Ok(vec![statement])
}

fn cassandra_permission(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "SELECT" => Ok("SELECT"),
        // Cassandra has one write permission covering insert/update/delete.
        "INSERT" | "UPDATE" | "DELETE" | "MODIFY" => Ok("MODIFY"),
        "ALTER" => Ok("ALTER"),
        "DROP" => Ok("DROP"),
        "AUTHORIZE" => Ok("AUTHORIZE"),
        "CREATE" => Ok("CREATE"),
        "DESCRIBE" => Ok("DESCRIBE"),
        "EXECUTE" => Ok("EXECUTE"),
        _ => Err(
            "Cassandra permission must be SELECT, MODIFY, ALTER, DROP, AUTHORIZE, CREATE, DESCRIBE, or EXECUTE."
                .to_string(),
        ),
    }
}

fn mongodb_statements(
    request: &UserRoleChangeRequest,
    user_name: &str,
    role_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let user_json = serde_json::to_string(user_name).map_err(|error| error.to_string())?;
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            let password = request
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|password| {
                    serde_json::to_string(password)
                        .map(|password| format!(", pwd: {password}"))
                        .map_err(|error| error.to_string())
                })
                .transpose()?
                .unwrap_or_default();
            format!("db.runCommand({{ createUser: {user_json}{password}, roles: [] }})")
        }
        UserRoleChangeAction::GrantRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            let role_json = serde_json::to_string(role).map_err(|error| error.to_string())?;
            format!("db.runCommand({{ grantRolesToUser: {user_json}, roles: [{role_json}] }})")
        }
        UserRoleChangeAction::RevokeRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            let role_json = serde_json::to_string(role).map_err(|error| error.to_string())?;
            format!("db.runCommand({{ revokeRolesFromUser: {user_json}, roles: [{role_json}] }})")
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            return Err(
                "MongoDB grants privileges through roles, not direct grants — create a role with the required privileges and grant it to the user."
                    .to_string(),
            );
        }
    };
    Ok(vec![statement])
}

/// Redis ACL user names are bare tokens — the command surface tokenizes with
/// shlex, so whitespace or quotes would corrupt the command line.
fn require_acl_token<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = require_identifier(value, label)?;
    if value
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '\'' | '"' | '\\'))
    {
        return Err(format!(
            "{label} cannot contain whitespace or quotes for Redis ACL."
        ));
    }
    Ok(value)
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn redis_acl_category(privilege: &str) -> Result<&'static str, String> {
    match privilege.trim().to_ascii_uppercase().as_str() {
        "SELECT" | "REFERENCES" => Ok("@read"),
        "INSERT" | "UPDATE" | "DELETE" | "TRIGGER" => Ok("@write"),
        _ => Err("Redis privilege must be SELECT, INSERT, UPDATE, or DELETE.".to_string()),
    }
}

fn redis_statements(
    request: &UserRoleChangeRequest,
    user_name: &str,
) -> Result<Vec<String>, String> {
    let user = require_acl_token(user_name, "User name")?;
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            // Passwords are sent as SHA-256 hashes (`#<digest>`) so the
            // plaintext never appears in the statement or the review dialog.
            let password = request
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|password| format!(" #{}", sha256_hex(password)))
                .unwrap_or_default();
            format!("ACL SETUSER {user} on{password}")
        }
        UserRoleChangeAction::GrantRole | UserRoleChangeAction::RevokeRole => {
            return Err(
                "Redis ACL has no roles — grant command categories or key patterns instead."
                    .to_string(),
            );
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            let privilege = request
                .privilege
                .as_deref()
                .ok_or_else(|| "Privilege is required.".to_string())?;
            let category = redis_acl_category(privilege)?;
            let sign = if matches!(request.action, UserRoleChangeAction::GrantPrivilege) {
                "+"
            } else {
                "-"
            };
            // The object name doubles as the key pattern the rule applies to.
            let pattern = request
                .object_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| require_acl_token(value, "Key pattern"))
                .transpose()?;
            match pattern {
                Some(pattern) => format!("ACL SETUSER {user} ~{pattern} {sign}{category}"),
                None => format!("ACL SETUSER {user} {sign}{category}"),
            }
        }
    };
    Ok(vec![statement])
}

/// OpenSearch security resources are addressed by URL path segment, so names
/// must not contain characters that would escape or corrupt the path.
fn require_opensearch_name<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = require_identifier(value, label)?;
    if value == "." || value == ".." || value.contains(['/', '?', '#']) {
        return Err(format!(
            "{label} cannot contain '/', '?', or '#' for OpenSearch."
        ));
    }
    Ok(value)
}

fn url_path_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// OpenSearch administration is a REST API, not SQL — the "statements" are
/// descriptive lines shown in the review dialog; `apply_opensearch_change`
/// performs the real calls.
fn opensearch_statements(
    request: &UserRoleChangeRequest,
    user_name: &str,
    role_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let user = require_opensearch_name(user_name, "User name")?;
    let statement = match request.action {
        UserRoleChangeAction::CreateUser => {
            format!("PUT /_plugins/_security/api/internalusers/{user}")
        }
        UserRoleChangeAction::GrantRole | UserRoleChangeAction::RevokeRole => {
            let role = require_opensearch_name(
                role_name.ok_or_else(|| "Role name is required.".to_string())?,
                "Role name",
            )?;
            let verb = if matches!(request.action, UserRoleChangeAction::GrantRole) {
                "add"
            } else {
                "remove"
            };
            format!("PUT /_plugins/_security/api/rolesmapping/{role} ({verb} user {user})")
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            return Err(
                "OpenSearch grants permissions through roles, not direct grants — map the user to a security role instead."
                    .to_string(),
            );
        }
    };
    Ok(vec![statement])
}

/// Safe Mode classifies SQL text, but OpenSearch admin operations are REST
/// calls — map the action to an equivalent SQL-shaped probe so the same
/// policy tiers apply.
fn opensearch_safe_mode_probe(request: &UserRoleChangeRequest) -> String {
    match request.action {
        UserRoleChangeAction::CreateUser => "CREATE USER".to_string(),
        UserRoleChangeAction::GrantRole | UserRoleChangeAction::GrantPrivilege => {
            "GRANT".to_string()
        }
        UserRoleChangeAction::RevokeRole | UserRoleChangeAction::RevokePrivilege => {
            "REVOKE".to_string()
        }
    }
}

async fn apply_opensearch_change(
    driver: &dyn crate::database::driver::DatabaseDriver,
    request: &UserRoleChangeRequest,
) -> Result<(), String> {
    let opensearch = driver
        .as_any()
        .and_then(|any| any.downcast_ref::<OpenSearchDriver>())
        .ok_or_else(|| {
            "OpenSearch administration requires the native OpenSearch driver.".to_string()
        })?;
    let user = require_opensearch_name(&request.user_name, "User name")?;
    match request.action {
        UserRoleChangeAction::CreateUser => {
            let mut body = json!({});
            if let Some(password) = request
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                body["password"] = json!(password);
            }
            opensearch
                .security_api_request(
                    Method::PUT,
                    &format!(
                        "/_plugins/_security/api/internalusers/{}",
                        url_path_segment(user)
                    ),
                    Some(&body),
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        UserRoleChangeAction::GrantRole | UserRoleChangeAction::RevokeRole => {
            let role = require_opensearch_name(
                request
                    .role_name
                    .as_deref()
                    .ok_or_else(|| "Role name is required.".to_string())?,
                "Role name",
            )?;
            let path = format!(
                "/_plugins/_security/api/rolesmapping/{}",
                url_path_segment(role)
            );
            let current = opensearch
                .security_api_request(Method::GET, &path, None)
                .await
                .map_err(|error| error.to_string())?;
            // The response is keyed by role name; fall back to the object
            // itself when it already is the mapping body.
            let mut mapping = current
                .get(role)
                .cloned()
                .filter(|value| value.is_object())
                .unwrap_or(current);
            if !mapping.is_object() {
                mapping = json!({});
            }
            let mut users = mapping
                .get("users")
                .and_then(|users| users.as_array())
                .cloned()
                .unwrap_or_default();
            let grant = matches!(request.action, UserRoleChangeAction::GrantRole);
            let present = users.iter().any(|entry| entry.as_str() == Some(user));
            if grant && !present {
                users.push(json!(user));
            } else if !grant {
                users.retain(|entry| entry.as_str() != Some(user));
            }
            mapping["users"] = JsonValue::Array(users);
            opensearch
                .security_api_request(Method::PUT, &path, Some(&mapping))
                .await
                .map_err(|error| error.to_string())?;
        }
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            return Err(
                "OpenSearch grants permissions through roles, not direct grants — map the user to a security role instead."
                    .to_string(),
            );
        }
    }
    Ok(())
}

// Vertica uses v_catalog tables — no pg_roles/pg_auth_members.
const VERTICA_PRINCIPALS_SQL: &str = "SELECT u.user_name, CASE WHEN u.is_super_user THEN 1 ELSE 0 END AS is_superuser, 1 AS can_login, COALESCE((SELECT string_agg(r.name, ',') FROM v_catalog.grants g JOIN v_catalog.roles r ON r.oid = g.grantee_id WHERE g.object_name = u.user_name AND g.object_type = 'ROLE'), '') AS roles FROM v_catalog.users u ORDER BY u.user_name";
const VERTICA_PRIVILEGES_SQL: &str = "SELECT grantee, object_schema || '.' || object_name || ':' || privileges_description AS privilege FROM v_catalog.grants WHERE object_type = 'TABLE' ORDER BY grantee, object_schema, object_name";

#[cfg(test)]
mod tests {
    use super::{
        build_executable_statements, build_review, collect_effective_privileges,
        UserRoleChangeAction, UserRoleChangeRequest,
    };
    use std::collections::HashMap;

    fn request(action: UserRoleChangeAction) -> UserRoleChangeRequest {
        UserRoleChangeRequest {
            action,
            user_name: "analyst\"team".to_string(),
            host: Some("localhost".to_string()),
            role_name: Some("read_only".to_string()),
            password: Some("not-for-logs".to_string()),
            privilege: None,
            object_name: None,
        }
    }

    #[test]
    fn postgres_review_quotes_identifiers_and_redacts_passwords() {
        let review =
            build_review("postgresql", &request(UserRoleChangeAction::CreateUser)).unwrap();
        assert_eq!(
            review.statements,
            vec!["CREATE ROLE \"analyst\"\"team\" LOGIN PASSWORD [REDACTED];"]
        );
        assert!(!review.statements[0].contains("not-for-logs"));
    }

    #[test]
    fn mysql_grant_is_generated_from_typed_fields() {
        let statements =
            build_executable_statements("mysql", &request(UserRoleChangeAction::GrantRole))
                .unwrap();
        assert_eq!(
            statements,
            vec!["GRANT `read_only` TO 'analyst\"team'@'localhost';"]
        );
    }

    #[test]
    fn postgres_password_keeps_backslashes_as_entered() {
        let mut request = request(UserRoleChangeAction::CreateUser);
        request.password = Some("one\\two".to_string());
        let statements = build_executable_statements("postgresql", &request).unwrap();
        assert_eq!(
            statements,
            vec!["CREATE ROLE \"analyst\"\"team\" LOGIN PASSWORD 'one\\two';"]
        );
    }

    #[test]
    fn effective_privileges_follow_nested_roles_without_cycles() {
        let direct = HashMap::from([
            ("analyst".to_string(), vec!["orders:SELECT".to_string()]),
            ("reporter".to_string(), vec!["reports:SELECT".to_string()]),
            ("base".to_string(), vec!["public:USAGE".to_string()]),
        ]);
        let roles = HashMap::from([
            ("analyst".to_string(), vec!["reporter".to_string()]),
            ("reporter".to_string(), vec!["base".to_string()]),
            ("base".to_string(), vec!["analyst".to_string()]),
        ]);
        assert_eq!(
            collect_effective_privileges("analyst", &direct, &roles),
            vec![
                "orders:SELECT".to_string(),
                "public:USAGE".to_string(),
                "reports:SELECT".to_string(),
            ]
        );
    }

    #[test]
    fn privilege_changes_are_allowlisted_and_quote_qualified_objects() {
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("select".to_string());
        request.object_name = Some("public.order items".to_string());
        assert_eq!(
            build_executable_statements("postgresql", &request).unwrap(),
            vec!["GRANT SELECT ON TABLE \"public\".\"order items\" TO \"analyst\"\"team\";"]
        );
        request.privilege = Some("SUPER".to_string());
        assert!(build_executable_statements("postgresql", &request).is_err());
    }

    #[test]
    fn mssql_create_user_builds_login_and_user() {
        let statements =
            build_executable_statements("mssql", &request(UserRoleChangeAction::CreateUser))
                .unwrap();
        assert_eq!(
            statements,
            vec![
                "CREATE LOGIN [analyst\"team] WITH PASSWORD = 'not-for-logs'; CREATE USER [analyst\"team] FOR LOGIN [analyst\"team];"
            ]
        );
    }

    #[test]
    fn mssql_role_membership_uses_alter_role_not_grant() {
        let statements =
            build_executable_statements("mssql", &request(UserRoleChangeAction::GrantRole))
                .unwrap();
        assert_eq!(
            statements,
            vec!["ALTER ROLE [read_only] ADD MEMBER [analyst\"team];"]
        );
        let statements =
            build_executable_statements("mssql", &request(UserRoleChangeAction::RevokeRole))
                .unwrap();
        assert_eq!(
            statements,
            vec!["ALTER ROLE [read_only] DROP MEMBER [analyst\"team];"]
        );
    }

    #[test]
    fn mssql_privilege_grant_uses_object_syntax() {
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("select".to_string());
        request.object_name = Some("dbo.order items".to_string());
        assert_eq!(
            build_executable_statements("mssql", &request).unwrap(),
            vec!["GRANT SELECT ON OBJECT::[dbo].[order items] TO [analyst\"team];"]
        );
    }

    #[test]
    fn snowflake_uses_user_and_role_keywords() {
        let statements =
            build_executable_statements("snowflake", &request(UserRoleChangeAction::CreateUser))
                .unwrap();
        assert_eq!(
            statements,
            vec!["CREATE USER \"analyst\"\"team\" PASSWORD = 'not-for-logs';"]
        );
        let statements =
            build_executable_statements("snowflake", &request(UserRoleChangeAction::GrantRole))
                .unwrap();
        assert_eq!(
            statements,
            vec!["GRANT ROLE \"read_only\" TO USER \"analyst\"\"team\";"]
        );
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("select".to_string());
        request.object_name = Some("analytics.orders".to_string());
        assert_eq!(
            build_executable_statements("snowflake", &request).unwrap(),
            vec!["GRANT SELECT ON TABLE \"analytics\".\"orders\" TO USER \"analyst\"\"team\";"]
        );
    }

    #[test]
    fn clickhouse_maps_mutations_to_alter_privileges() {
        let statements =
            build_executable_statements("clickhouse", &request(UserRoleChangeAction::CreateUser))
                .unwrap();
        assert_eq!(
            statements,
            vec!["CREATE USER `analyst\"team` HOST IP 'localhost' IDENTIFIED BY 'not-for-logs';"]
        );
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("delete".to_string());
        request.object_name = Some("analytics.orders".to_string());
        assert_eq!(
            build_executable_statements("clickhouse", &request).unwrap(),
            vec!["GRANT ALTER DELETE ON `analytics`.`orders` TO `analyst\"team`;"]
        );
        request.privilege = Some("TRIGGER".to_string());
        assert!(build_executable_statements("clickhouse", &request).is_err());
    }

    #[test]
    fn cassandra_creates_login_roles_and_maps_modify() {
        let statements =
            build_executable_statements("cassandra", &request(UserRoleChangeAction::CreateUser))
                .unwrap();
        assert_eq!(
            statements,
            vec![
                "CREATE ROLE \"analyst\"\"team\" WITH LOGIN = true AND PASSWORD = 'not-for-logs';"
            ]
        );
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("insert".to_string());
        request.object_name = Some("app.orders".to_string());
        assert_eq!(
            build_executable_statements("cassandra", &request).unwrap(),
            vec!["GRANT MODIFY ON TABLE \"app\".\"orders\" TO \"analyst\"\"team\";"]
        );
    }

    #[test]
    fn mongodb_builds_run_command_documents() {
        let statements =
            build_executable_statements("mongodb", &request(UserRoleChangeAction::CreateUser))
                .unwrap();
        assert_eq!(
            statements,
            vec![
                "db.runCommand({ createUser: \"analyst\\\"team\", pwd: \"not-for-logs\", roles: [] })"
            ]
        );
        let statements =
            build_executable_statements("mongodb", &request(UserRoleChangeAction::GrantRole))
                .unwrap();
        assert_eq!(
            statements,
            vec![
                "db.runCommand({ grantRolesToUser: \"analyst\\\"team\", roles: [\"read_only\"] })"
            ]
        );
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("select".to_string());
        request.object_name = Some("app.orders".to_string());
        assert!(build_executable_statements("mongodb", &request).is_err());
    }

    #[test]
    fn mongodb_review_redacts_json_password() {
        let review = build_review("mongodb", &request(UserRoleChangeAction::CreateUser)).unwrap();
        assert_eq!(
            review.statements,
            vec!["db.runCommand({ createUser: \"analyst\\\"team\", pwd: [REDACTED] })"]
        );
        assert!(!review.statements[0].contains("not-for-logs"));
    }

    #[test]
    fn redis_builds_acl_commands_and_hashes_passwords() {
        let mut create = request(UserRoleChangeAction::CreateUser);
        create.user_name = "analyst".to_string();
        let statements = build_executable_statements("redis", &create).unwrap();
        assert_eq!(statements.len(), 1);
        assert!(statements[0].starts_with("ACL SETUSER analyst on #"));
        assert!(!statements[0].contains("not-for-logs"));
        let mut grant = request(UserRoleChangeAction::GrantPrivilege);
        grant.user_name = "analyst".to_string();
        grant.privilege = Some("select".to_string());
        grant.object_name = Some("cache:*".to_string());
        assert_eq!(
            build_executable_statements("redis", &grant).unwrap(),
            vec!["ACL SETUSER analyst ~cache:* +@read"]
        );
        let mut role_request = request(UserRoleChangeAction::GrantRole);
        role_request.user_name = "analyst".to_string();
        assert!(build_executable_statements("redis", &role_request).is_err());
        // Quoted names would corrupt the shlex-tokenized command line.
        let mut bad = request(UserRoleChangeAction::CreateUser);
        bad.user_name = "analyst\"team".to_string();
        assert!(build_executable_statements("redis", &bad).is_err());
    }

    #[test]
    fn opensearch_describes_rest_calls_and_rejects_direct_grants() {
        let statements =
            build_executable_statements("opensearch", &request(UserRoleChangeAction::CreateUser))
                .unwrap();
        assert_eq!(
            statements,
            vec!["PUT /_plugins/_security/api/internalusers/analyst\"team"]
        );
        let mut request = request(UserRoleChangeAction::GrantPrivilege);
        request.privilege = Some("select".to_string());
        request.object_name = Some("logs-*".to_string());
        assert!(build_executable_statements("opensearch", &request).is_err());
    }
}
