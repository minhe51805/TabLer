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
    pub direct_privileges: Vec<String>,
    pub effective_privileges: Vec<String>,
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
            let privileges = driver.execute_query(POSTGRES_PRIVILEGES_SQL).await.ok();
            Ok(UserRoleSnapshot {
                engine,
                principals: postgres_principals(result, privileges),
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
    let privilege = request
        .privilege
        .as_deref()
        .map(|value| require_privilege(value))
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
        UserRoleChangeAction::GrantPrivilege | UserRoleChangeAction::RevokePrivilege => {
            let privilege = privilege.ok_or_else(|| "Privilege is required.".to_string())?;
            let object_name = request
                .object_name
                .as_deref()
                .ok_or_else(|| "Object name is required.".to_string())?;
            let object = quote_qualified_object(object_name, is_postgres)?;
            let verb = if matches!(request.action, UserRoleChangeAction::GrantPrivilege) {
                "GRANT"
            } else {
                "REVOKE"
            };
            let direction = if verb == "GRANT" { "TO" } else { "FROM" };
            if is_postgres {
                format!("{verb} {privilege} ON TABLE {object} {direction} {user};")
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

fn quote_qualified_object(value: &str, postgres: bool) -> Result<String, String> {
    let parts = value.split('.').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 {
        return Err("Object name must contain one to three qualified identifiers.".to_string());
    }
    parts
        .into_iter()
        .map(|part| {
            let identifier = require_identifier(part, "Object identifier")?;
            Ok(if postgres {
                quote_postgres_identifier(identifier)
            } else {
                quote_mysql_identifier(identifier)
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
}
