use std::path::PathBuf;

/// Read the ~/.pgpass file (or %APPDATA%\postgresql\pgpass.conf on Windows).
/// Returns the first matching password for the given host:port:database:username.
pub(crate) fn read_pgpass(host: &str, port: u16, database: &str, username: &str) -> Option<String> {
    let pgpass_path = if cfg!(windows) {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("postgresql")
            .join("pgpass.conf")
    } else {
        dirs::home_dir()?.join(".pgpass")
    };

    let content = std::fs::read_to_string(&pgpass_path).ok()?;
    let port_string = port.to_string();
    for line in content.lines() {
        let line = line.trim();
        // Skip comments and empty lines
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Format: hostname:port:database:username:password
        // The password is the last field; extra separators belong to it.
        let fields: Vec<&str> = line.split(':').collect();
        let [pg_host, pg_port, pg_db, pg_user, password, ..] = fields.as_slice() else {
            continue;
        };

        let line_matches = [
            (pg_host, host),
            (pg_port, port_string.as_str()),
            (pg_db, database),
            (pg_user, username),
        ]
        .into_iter()
        .all(|(pattern, value)| match_pattern(pattern, value));
        if !line_matches {
            continue;
        }

        // Unescape colons and backslashes in password
        return Some(password.replace("\\:", ":").replace("\\\\", "\\"));
    }
    None
}

/// Match a pgpass pattern against a value. '*' matches anything.
fn match_pattern(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    pattern == value
}

/// Read ~/.pg_service.conf (libpq service file).
/// Returns connection parameters for the matching service name.
#[allow(dead_code)]
pub(crate) fn read_pg_service(service: &str) -> Option<(String, Option<u16>, Option<String>)> {
    let service_path = dirs::home_dir()?.join(".pg_service.conf");
    let content = std::fs::read_to_string(&service_path).ok()?;

    let mut in_service = false;
    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut password: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            let current_service = &line[1..line.len() - 1];
            if in_service {
                // End of service block
                break;
            }
            if current_service == service {
                in_service = true;
                continue;
            }
        }

        if in_service {
            if let Some((key, val)) = line.split_once('=') {
                let key = key.trim();
                let val = val.trim();
                match key {
                    "host" => host = Some(val.to_string()),
                    "port" => port = val.parse().ok(),
                    "password" => password = Some(val.to_string()),
                    _ => {}
                }
            }
        }
    }

    if in_service && (host.is_some() || password.is_some()) {
        // Return host if found, plus port and password
        Some((host.unwrap_or_default(), port, password))
    } else {
        None
    }
}