use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkConnect {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub db_type: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkQuery {
    pub connection: Option<String>,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkTable {
    pub connection: Option<String>,
    pub database: Option<String>,
    pub table: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum DeepLinkRequest {
    #[serde(rename = "connect")]
    Connect(DeepLinkConnect),
    #[serde(rename = "query")]
    Query(DeepLinkQuery),
    #[serde(rename = "table")]
    Table(DeepLinkTable),
}

impl DeepLinkRequest {
    pub fn parse(url: &str) -> Option<Self> {
        let url = url.trim();
        if !url.starts_with("tabler://") {
            return None;
        }

        let path = url.strip_prefix("tabler://")?;
        let (action, query) = if let Some(idx) = path.find('?') {
            (&path[..idx], Some(&path[idx + 1..]))
        } else {
            (path, None)
        };

        let params = query.and_then(|q| {
            let mut map = std::collections::HashMap::new();
            for pair in q.split('&') {
                let mut parts = pair.splitn(2, '=');
                if let (Some(key), Some(val)) = (parts.next(), parts.next()) {
                    map.insert(
                        key.to_string(),
                        urlencoding_decode(val).unwrap_or_else(|| val.to_string()),
                    );
                }
            }
            if map.is_empty() { None } else { Some(map) }
        });

        match action {
            "connect" => {
                let p = params?;
                Some(DeepLinkRequest::Connect(DeepLinkConnect {
                    host: p.get("host").cloned(),
                    port: p.get("port").and_then(|v| v.parse().ok()),
                    database: p.get("database").cloned(),
                    db_type: p.get("db_type").cloned(),
                    user: p.get("user").cloned(),
                    password: p.get("password").cloned(),
                }))
            }
            "query" => {
                let p = params?;
                Some(DeepLinkRequest::Query(DeepLinkQuery {
                    connection: p.get("connection").cloned(),
                    sql: p.get("sql").cloned(),
                }))
            }
            "table" => {
                let p = params?;
                Some(DeepLinkRequest::Table(DeepLinkTable {
                    connection: p.get("connection").cloned(),
                    database: p.get("database").cloned(),
                    table: p.get("table").cloned(),
                }))
            }
            _ => None,
        }
    }
}

fn urlencoding_decode(input: &str) -> Option<String> {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if hex.len() == 2 {
                let byte = u8::from_str_radix(&hex, 16).ok()?;
                output.push(byte as char);
            } else {
                output.push('%');
                output.extend(hex.chars());
            }
        } else if ch == '+' {
            output.push(' ');
        } else {
            output.push(ch);
        }
    }

    Some(output)
}

#[tauri::command]
pub fn parse_deep_link(url: String) -> Result<DeepLinkRequest, String> {
    DeepLinkRequest::parse(&url).ok_or_else(|| format!("Unknown or malformed deep link URL: {}", url))
}
