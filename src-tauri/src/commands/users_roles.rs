use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use serde::{Deserialize, Serialize};
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
    pub privileges: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleSnapshot {
    pub engine: String,
    pub principals: Vec<UserRolePrincipal>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UserRoleChangeAction {
    CreateUser,
    GrantRole,
    RevokeRole,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleChangeRequest {
    pub action: UserRoleChangeAction,
    pub user_name: String,
    pub host: Option<String>,
    pub role_name: Option<String>,
    pub password: Option<String>,
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
    db_manager
        .require_capability(&connection_id, DriverCapability::Administration)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let engine = driver.driver_name().to_string();
    match engine.as_str() {
        "postgresql" | "greenplum" => {
            let result = driver
                .execute_query(POSTGRES_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            Ok(UserRoleSnapshot {
                engine,
                principals: postgres_principals(result),
            })
        }
        "mysql" | "mariadb" => {
            let users = driver
                .execute_query(MYSQL_PRINCIPALS_SQL)
                .await
                .map_err(|error| error.to_string())?;
            let privileges = driver.execute_query(MYSQL_PRIVILEGES_SQL).await.ok();
            let role_memberships = driver
                .execute_query(if engine == "mariadb" {
                    MARIADB_ROLE_MEMBERSHIPS_SQL
                } else {
                    MYSQL_ROLE_MEMBERSHIPS_SQL
                })
                .await
                .ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: mysql_principals(users, privileges, role_memberships),
            })
        }
        _ => Err(
            "Users & Roles is currently available for PostgreSQL, MySQL, and MariaDB.".to_string(),
        ),
    }
}

#[tauri::command]
pub async fn review_user_role_change(
    connection_id: String,
    request: UserRoleChangeRequest,
    db_manager: State<'_, DatabaseManager>,
) -> Result<UserRoleChangeReview, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::Administration)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    build_review(driver.driver_name(), &request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_user_role_change(
    connection_id: String,
    request: UserRoleChangeRequest,
    confirmation_phrase: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<UserRoleSnapshot, String> {
    if confirmation_phrase.trim() != APPLY_CONFIRMATION {
        return Err("Explicit confirmation phrase did not match.".to_string());
    }
    db_manager
        .require_capability(&connection_id, DriverCapability::Administration)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let statements = build_executable_statements(driver.driver_name(), &request)
        .map_err(|error| error.to_string())?;
    for statement in statements {
        driver
            .execute_query(&statement)
            .await
            .map_err(|error| error.to_string())?;
    }
    drop(driver);
    get_user_role_snapshot(connection_id, db_manager).await
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
    let is_postgres = matches!(engine, "postgresql" | "greenplum");
    let is_mysql = matches!(engine, "mysql" | "mariadb");
    if !is_postgres && !is_mysql {
        return Err(
            "Users & Roles is currently available for PostgreSQL, MySQL, and MariaDB.".to_string(),
        );
    }
    let user = if is_postgres {
        quote_postgres_identifier(user_name)
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
            let role = if is_postgres {
                quote_postgres_identifier(role)
            } else {
                quote_mysql_identifier(role)
            };
            format!("GRANT {role} TO {user};")
        }
        UserRoleChangeAction::RevokeRole => {
            let role = role_name.ok_or_else(|| "Role name is required.".to_string())?;
            let role = if is_postgres {
                quote_postgres_identifier(role)
            } else {
                quote_mysql_identifier(role)
            };
            format!("REVOKE {role} FROM {user};")
        }
    };
    Ok(vec![statement])
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
    statement.to_string()
}

fn postgres_principals(result: QueryResult) -> Vec<UserRolePrincipal> {
    result
        .rows
        .into_iter()
        .map(|row| {
            let name = row_string(&row, 0);
            UserRolePrincipal {
                id: name.clone(),
                name,
                host: None,
                can_login: row_bool(&row, 1),
                is_superuser: row_bool(&row, 2),
                roles: split_csv(&row_string(&row, 3)),
                privileges: Vec::new(),
            }
        })
        .collect()
}

fn mysql_principals(
    users: QueryResult,
    privileges: Option<QueryResult>,
    memberships: Option<QueryResult>,
) -> Vec<UserRolePrincipal> {
    let mut privilege_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(privileges) = privileges {
        for row in privileges.rows {
            privilege_map
                .entry(normalize_mysql_grantee(&row_string(&row, 0)))
                .or_default()
                .push(row_string(&row, 1));
        }
    }
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
            UserRolePrincipal {
                id: id.clone(),
                name,
                host: Some(host),
                can_login: true,
                is_superuser: false,
                roles: role_map.remove(&id).unwrap_or_default(),
                privileges: privilege_map.remove(&id).unwrap_or_default(),
            }
        })
        .collect()
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

fn normalize_mysql_grantee(value: &str) -> String {
    value
        .trim()
        .trim_matches('\'')
        .replace("'@'", "@")
        .replace("''", "'")
}

const POSTGRES_PRINCIPALS_SQL: &str = "SELECT r.rolname AS user_name, r.rolcanlogin AS can_login, r.rolsuper AS is_superuser, COALESCE(string_agg(DISTINCT parent.rolname, ','), '') AS roles FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member = r.oid LEFT JOIN pg_roles parent ON parent.oid = m.roleid GROUP BY r.rolname, r.rolcanlogin, r.rolsuper ORDER BY r.rolname";
const MYSQL_PRINCIPALS_SQL: &str = "SELECT User AS user_name, Host AS host_name FROM mysql.user WHERE User <> '' ORDER BY User, Host";
const MYSQL_PRIVILEGES_SQL: &str = "SELECT GRANTEE, PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE, PRIVILEGE_TYPE";
const MYSQL_ROLE_MEMBERSHIPS_SQL: &str = "SELECT CONCAT(TO_USER, '@', TO_HOST) AS grantee, CONCAT(FROM_USER, '@', FROM_HOST) AS role_name FROM mysql.role_edges ORDER BY TO_USER, TO_HOST, FROM_USER, FROM_HOST";
const MARIADB_ROLE_MEMBERSHIPS_SQL: &str = "SELECT CONCAT(User, '@', Host) AS grantee, Role AS role_name FROM mysql.roles_mapping ORDER BY User, Host, Role";

#[cfg(test)]
mod tests {
    use super::{
        build_executable_statements, build_review, UserRoleChangeAction, UserRoleChangeRequest,
    };

    fn request(action: UserRoleChangeAction) -> UserRoleChangeRequest {
        UserRoleChangeRequest {
            action,
            user_name: "analyst\"team".to_string(),
            host: Some("localhost".to_string()),
            role_name: Some("read_only".to_string()),
            password: Some("not-for-logs".to_string()),
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
}
