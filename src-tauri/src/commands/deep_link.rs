use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MAX_DEEP_LINK_LENGTH: usize = 8 * 1024;
const MAX_SQL_LENGTH: usize = 6 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkConnect {
    pub connection: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkQuery {
    pub connection: String,
    pub database: Option<String>,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkTable {
    pub connection: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkMetrics {
    pub connection: String,
    pub database: Option<String>,
    pub board: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkErd {
    pub connection: String,
    pub database: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action")]
pub enum DeepLinkRequest {
    #[serde(rename = "connect")]
    Connect(DeepLinkConnect),
    #[serde(rename = "query")]
    Query(DeepLinkQuery),
    #[serde(rename = "table")]
    Table(DeepLinkTable),
    #[serde(rename = "metrics")]
    Metrics(DeepLinkMetrics),
    #[serde(rename = "erd")]
    Erd(DeepLinkErd),
}

fn take_required(params: &mut HashMap<String, String>, key: &str) -> Result<String, String> {
    params
        .remove(key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Deep link requires a non-empty '{key}' parameter."))
}

fn take_optional(params: &mut HashMap<String, String>, key: &str) -> Option<String> {
    params
        .remove(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn ensure_no_unknown_params(params: HashMap<String, String>) -> Result<(), String> {
    if params.is_empty() {
        return Ok(());
    }
    let mut keys = params.into_keys().collect::<Vec<_>>();
    keys.sort();
    Err(format!(
        "Deep link contains unsupported parameter(s): {}.",
        keys.join(", ")
    ))
}

impl DeepLinkRequest {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if raw.len() > MAX_DEEP_LINK_LENGTH {
            return Err("Deep link exceeds the maximum allowed length.".to_string());
        }
        let url = Url::parse(raw).map_err(|_| "Deep link URL is malformed.".to_string())?;
        if url.scheme() != "tabler" {
            return Err("Deep link must use the tabler:// scheme.".to_string());
        }
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            return Err("Deep links cannot contain credentials or a port.".to_string());
        }
        if url.fragment().is_some() {
            return Err("Deep links cannot contain a fragment.".to_string());
        }
        if !url.path().is_empty() && url.path() != "/" {
            return Err("Deep link actions cannot contain nested paths.".to_string());
        }
        let action = url
            .host_str()
            .ok_or_else(|| "Deep link action is missing.".to_string())?;

        let mut seen = HashSet::new();
        let mut params = HashMap::new();
        for (key, value) in url.query_pairs() {
            let key = key.into_owned();
            if !seen.insert(key.clone()) {
                return Err(format!("Deep link parameter '{key}' is duplicated."));
            }
            params.insert(key, value.into_owned());
        }

        let request = match action {
            "connect" => {
                let connection = take_required(&mut params, "connection")?;
                DeepLinkRequest::Connect(DeepLinkConnect { connection })
            }
            "query" => {
                let connection = take_required(&mut params, "connection")?;
                let database = take_optional(&mut params, "database");
                let sql = take_optional(&mut params, "sql");
                if sql
                    .as_ref()
                    .is_some_and(|value| value.len() > MAX_SQL_LENGTH)
                {
                    return Err("Deep link SQL exceeds the maximum allowed length.".to_string());
                }
                DeepLinkRequest::Query(DeepLinkQuery {
                    connection,
                    database,
                    sql,
                })
            }
            "table" => {
                let connection = take_required(&mut params, "connection")?;
                let database = take_optional(&mut params, "database");
                let schema = take_optional(&mut params, "schema");
                let table = take_required(&mut params, "table")?;
                DeepLinkRequest::Table(DeepLinkTable {
                    connection,
                    database,
                    schema,
                    table,
                })
            }
            "metrics" => {
                let connection = take_required(&mut params, "connection")?;
                let database = take_optional(&mut params, "database");
                let board = take_optional(&mut params, "board");
                DeepLinkRequest::Metrics(DeepLinkMetrics {
                    connection,
                    database,
                    board,
                })
            }
            "erd" => {
                let connection = take_required(&mut params, "connection")?;
                let database = take_optional(&mut params, "database");
                DeepLinkRequest::Erd(DeepLinkErd {
                    connection,
                    database,
                })
            }
            _ => return Err(format!("Unknown deep link action '{action}'.")),
        };
        ensure_no_unknown_params(params)?;
        Ok(request)
    }
}

#[tauri::command]
pub fn parse_deep_link(url: String) -> Result<DeepLinkRequest, String> {
    DeepLinkRequest::parse(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_supported_workspace_target() {
        assert!(matches!(
            DeepLinkRequest::parse("tabler://connect?connection=local-pg").unwrap(),
            DeepLinkRequest::Connect(_)
        ));
        assert!(matches!(
            DeepLinkRequest::parse("tabler://query?connection=local-pg&sql=SELECT%201").unwrap(),
            DeepLinkRequest::Query(_)
        ));
        assert!(matches!(
            DeepLinkRequest::parse("tabler://table?connection=local-pg&schema=public&table=users")
                .unwrap(),
            DeepLinkRequest::Table(_)
        ));
        assert!(matches!(
            DeepLinkRequest::parse("tabler://metrics?connection=local-pg&board=health").unwrap(),
            DeepLinkRequest::Metrics(_)
        ));
        assert!(matches!(
            DeepLinkRequest::parse("tabler://erd?connection=local-pg&database=app").unwrap(),
            DeepLinkRequest::Erd(_)
        ));
    }

    #[test]
    fn rejects_credentials_unknown_fields_and_duplicates() {
        assert!(DeepLinkRequest::parse("tabler://user:secret@query?connection=x").is_err());
        assert!(DeepLinkRequest::parse("tabler://query?connection=x&password=secret").is_err());
        assert!(DeepLinkRequest::parse("tabler://query?connection=x&connection=y").is_err());
    }

    #[test]
    fn query_payload_is_open_only_metadata() {
        let request = DeepLinkRequest::parse(
            "tabler://query?connection=local-pg&database=app&sql=DELETE%20FROM%20users",
        )
        .unwrap();
        assert_eq!(
            request,
            DeepLinkRequest::Query(DeepLinkQuery {
                connection: "local-pg".to_string(),
                database: Some("app".to_string()),
                sql: Some("DELETE FROM users".to_string()),
            })
        );
    }
}
