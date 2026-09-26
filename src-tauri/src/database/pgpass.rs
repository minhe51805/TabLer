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
    parse_pgpass_content(&content, host, port, database, username)
}

/// Parses `.pgpass` file contents, returning the first password whose
/// hostname:port:database:username fields match. Extracted so the escaping
/// rules can be tested without touching the filesystem.
fn parse_pgpass_content(
    content: &str,
    host: &str,
    port: u16,
    database: &str,
    username: &str,
) -> Option<String> {
    let port_string = port.to_string();
    for line in content.lines() {
        let line = line.trim();
        // Skip comments and empty lines
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Format: hostname:port:database:username:password, with ':' and '\'
        // escapable in ANY field by a backslash.
        let Some(fields) = split_pgpass_line(line) else {
            continue;
        };
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

        return Some(password.clone());
    }
    None
}

/// Splits one `.pgpass` line on unescaped ':' separators. '\:' yields a
/// literal ':' and '\\' a literal '\'. Returns `None` when the line has fewer
/// than the required five fields. The password is field 5 — like libpq and
/// the previous naive split, an extra unescaped ':' ends it.
fn split_pgpass_line(line: &str) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some(escaped) => current.push(escaped),
                None => current.push('\\'),
            },
            ':' if fields.len() < 4 => {
                fields.push(std::mem::take(&mut current));
            }
            ':' => break, // 5th field (password) ends at the next unescaped ':'
            _ => current.push(ch),
        }
    }
    fields.push(current);
    (fields.len() >= 5).then_some(fields)
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
    parse_pg_service_content(&content, service)
}

/// Parses `.pg_service.conf` contents, returning `(host, port, password)` for
/// the named `[service]` block.
fn parse_pg_service_content(
    content: &str,
    service: &str,
) -> Option<(String, Option<u16>, Option<String>)> {
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

#[cfg(test)]
mod tests {
    use super::{parse_pg_service_content, parse_pgpass_content};

    const PGPASS: &str = "\
# comment line

localhost:5432:appdb:alice:secret1
*:5432:appdb:bob:wildport
localhost:5433:*:alice:anydb
short:1:2:3
";

    #[test]
    fn matches_exact_fields_and_first_match_wins() {
        assert_eq!(
            parse_pgpass_content(PGPASS, "localhost", 5432, "appdb", "alice"),
            Some("secret1".to_string())
        );
        // A different database misses the first line's db field.
        assert_eq!(
            parse_pgpass_content(PGPASS, "localhost", 5432, "otherdb", "alice"),
            None
        );
    }

    #[test]
    fn wildcard_fields_match_anything() {
        assert_eq!(
            parse_pgpass_content(PGPASS, "anything", 5432, "appdb", "bob"),
            Some("wildport".to_string())
        );
        assert_eq!(
            parse_pgpass_content(PGPASS, "localhost", 5433, "anydb", "alice"),
            Some("anydb".to_string())
        );
        // '*' matches only the field it occupies — wrong port still misses.
        assert_eq!(
            parse_pgpass_content(PGPASS, "localhost", 9999, "appdb", "bob"),
            None
        );
    }

    #[test]
    fn escaped_colons_and_backslashes_roundtrip() {
        let content = "h\\:ost:5432:db:u:p\\:w\\\\x";
        // Escaped ':' inside the host field, and a password containing both
        // an escaped colon and an escaped backslash.
        assert_eq!(
            parse_pgpass_content(content, "h:ost", 5432, "db", "u"),
            Some("p:w\\x".to_string())
        );
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let content = "too:few:fields\nlocalhost:5432:db:u:pw\n";
        assert_eq!(
            parse_pgpass_content(content, "localhost", 5432, "db", "u"),
            Some("pw".to_string())
        );
        assert_eq!(parse_pgpass_content("a:b:c\n", "a", 1, "b", "c"), None);
    }

    #[test]
    fn pg_service_reads_named_block_only() {
        let content = "\
# services
[other]
host=elsewhere

[main]
host = db.internal
port = 5544
password = hunter2

[later]
host=late
";
        assert_eq!(
            parse_pg_service_content(content, "main"),
            Some((
                "db.internal".to_string(),
                Some(5544),
                Some("hunter2".to_string())
            ))
        );
        // The next `[section]` ends the block — `later`'s keys never leak in.
        assert_eq!(
            parse_pg_service_content(content, "later"),
            Some(("late".to_string(), None, None))
        );
        assert_eq!(parse_pg_service_content(content, "missing"), None);
    }
}
