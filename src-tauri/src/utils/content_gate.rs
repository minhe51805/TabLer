//! Shared content gate for agent-writable stores.
//!
//! The agent persists durable knowledge into `agent-memory/`,
//! `agent-memory-native/` and `semantic_glossary.json`. Those files are
//! deliberately human-readable (a knowledge base the user can inspect and
//! edit), so the tradeoff is *what may enter them*, not encryption. This
//! gate rejects payloads that look like credentials or raw row identifiers
//! — the things that must never round-trip into a knowledge file — while
//! still allowing schema semantics (enum values, units, business rules).
//!
//! One module, one policy: `agent_memory`, `semantic_storage` and
//! `agent_memory_native` all call [`reject_sensitive_payload`] so a drift in
//! one store cannot quietly reopen a hole the others closed.

/// Credential-shaped strings (`key: value` / `key = value`). The original
/// memory gate only covered these; row-identifier shapes were added after a
/// real memory file was found carrying a Mongo ObjectId verbatim.
const CREDENTIAL_PATTERNS: &[(&str, &str)] = &[
    ("password\\s*[:=]\\s*\\S+", "password"),
    ("passwd\\s*[:=]\\s*\\S+", "password"),
    ("pwd\\s*[:=]\\s*\\S+", "password"),
    ("ssh_password\\s*[:=]\\s*\\S+", "ssh password"),
    ("ssh_private_key\\s*[:=]\\s*\\S+", "ssh private key"),
    ("passphrase\\s*[:=]\\s*\\S+", "passphrase"),
    ("private[_-]?key\\s*[:=]\\s*\\S+", "private key"),
    ("api[_-]?key\\s*[:=]\\s*\\S+", "api key"),
];

/// Row-value / PII-shaped strings. A memory that captures "the audit row's
/// user_id is 6a69dd9a…" leaks a live identifier — that is data, not
/// semantics. Only forms with near-zero legitimate use in a knowledge note
/// are listed; generic long numbers (timestamps, version strings) are left
/// alone deliberately.
const ROW_VALUE_PATTERNS: &[(&str, &str)] = &[
    // someone@example.com — emails in a knowledge note are almost always
    // a copied row value, never a rule.
    (
        "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
        "email address",
    ),
    // Mongo ObjectId / similar 24-hex identifiers.
    ("\\b[0-9a-fA-F]{24}\\b", "24-hex row identifier"),
    // JWTs (three base64url segments; header starts with eyJ in practice).
    (
        "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b",
        "JWT token",
    ),
    // US SSN 123-45-6789.
    ("\\b\\d{3}-\\d{2}-\\d{4}\\b", "social security number"),
    // Payment card numbers (13–19 digits, optionally grouped).
    (
        "\\b(?:\\d[ -]?){13,19}\\b",
        "payment card or long account number",
    ),
];

/// Rejects a payload that looks like a credential or a raw row identifier.
/// `where_label` names the field in the error so the caller can say *what*
/// was refused (memory body, glossary definition, file text).
pub fn reject_sensitive_payload(text: &str, where_label: &str) -> Result<(), String> {
    for (pattern, label) in CREDENTIAL_PATTERNS.iter().chain(ROW_VALUE_PATTERNS.iter()) {
        let Ok(regex) = regex::Regex::new(&format!("(?i){pattern}")) else {
            continue;
        };
        if regex.is_match(text) {
            return Err(format!(
                "Refusing to save: the {where_label} looks like it contains a {label}. Durable notes must carry semantics (rules, meanings, units), not credentials or row values."
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::reject_sensitive_payload;

    #[test]
    fn credentials_are_rejected() {
        for body in [
            "the reporting password: hunter2 is weak",
            "config uses ssh_private_key = AAAAB3Nza",
            "api_key: sk-123",
            "passphrase=s3cret",
        ] {
            assert!(reject_sensitive_payload(body, "body").is_err(), "{body}");
        }
    }

    #[test]
    fn row_identifiers_are_rejected() {
        for body in [
            "owner email admin@acme-corp.io receives the alerts",
            "the writer was user_id=6a69dd9a326709cf18a32d44",
            "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
            "primary SSN 123-45-6789 found in customers",
            "card on file 4111 1111 1111 1111",
        ] {
            assert!(reject_sensitive_payload(body, "body").is_err(), "{body}");
        }
    }

    #[test]
    fn schema_semantics_still_pass() {
        for body in [
            "status column uses enum 'paid' | 'cancelled' | 'refunded'",
            "amounts are stored in cents, not dollars",
            "is_deleted marks a soft delete; never filter it out for audits",
            "revenue = sum(amount) where status='paid'",
            "quarterly revenue notes",
            // Version-like and timestamp-like numbers are not card numbers.
            "migration 2026.09.26 backfills v0.1.6 rows",
            "interval_seconds must stay between 60 and 86400",
        ] {
            assert!(reject_sensitive_payload(body, "body").is_ok(), "{body}");
        }
    }
}
