//! Password-based export encryption shared by every export surface that can
//! produce a user-facing file: connection exports, database dumps, table data
//! exports, and workspace bundles.
//!
//! The on-disk document is a versioned JSON envelope —
//!
//! ```json
//! {
//!   "version": 1,
//!   "format": "tabler.export",
//!   "cipher": "AES-256-GCM",
//!   "kdf": "PBKDF2-HMAC-SHA256",
//!   "iterations": 600000,
//!   "salt": "<b64, 32 bytes>",
//!   "nonce": "<b64, 12 bytes>",
//!   "data": "<b64 ciphertext>"
//! }
//! ```
//!
//! — the same scheme the connection export uses (which predates this module
//! and keeps `format: "tabler.connection-export"`, `version: 2`). Ciphertext
//! is authenticated against the AAD `tabler.export.v1|<kind>`, so an envelope
//! produced for one export kind cannot be replayed into another decrypt path.
//!
//! Encrypted files are written next to the plaintext name with a `.texp`
//! suffix appended (`dump.sql.texp`) so the embedded format stays visible.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac_array;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Lower bound accepted when decrypting; anything above `MAX_KDF_ITERATIONS`
/// is refused so a hostile file cannot stall the app for minutes.
pub(crate) const MIN_KDF_ITERATIONS: u32 = 100_000;
pub(crate) const MAX_KDF_ITERATIONS: u32 = 2_000_000;
/// PBKDF2-HMAC-SHA256 work factor for new envelopes (OWASP 2023 guidance).
pub(crate) const PBKDF2_ITERATIONS: u32 = 600_000;
/// Minimum export password length, same rule as connection exports.
pub(crate) const MIN_PASSWORD_LEN: usize = 10;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;
/// `format` value stamped on envelopes produced by `encrypt_export_payload`.
const EXPORT_FORMAT: &str = "tabler.export";
const EXPORT_AAD_PREFIX: &str = "tabler.export.v1|";

/// Enforce the export password rule (shared with connection exports).
/// Callers should run this before the work starts so a bad password fails
/// before the save dialog and before any data is pulled.
pub(crate) fn validate_export_password(password: &str) -> Result<(), String> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters."
        ));
    }
    Ok(())
}

/// Serialized on-disk envelope. Shared with the connection export (it
/// deserializes its v2 files through this type), so field names and the
/// `camelCase` convention are load-bearing.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportEnvelope {
    pub version: u8,
    pub format: String,
    pub cipher: String,
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub nonce: String,
    pub data: String,
}

/// Derive a 256-bit key from password using PBKDF2-HMAC-SHA256.
pub(crate) fn derive_export_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, iterations)
}

/// AAD binding the ciphertext to one export kind ("table", "database",
/// "bundle", ...). New envelopes are written by `encrypt_export_payload`.
pub(crate) fn export_aad(kind: &str) -> Vec<u8> {
    format!("{EXPORT_AAD_PREFIX}{kind}").into_bytes()
}

/// Encrypt `plaintext` into an [`ExportEnvelope`] with caller-chosen
/// `format`/`aad`/`version`. Connection exports reuse this with their own
/// format string and version 2; everything else goes through
/// `encrypt_export_payload`.
pub(crate) fn encrypt_envelope(
    plaintext: &[u8],
    password: &str,
    format: &str,
    aad: &[u8],
    version: u8,
) -> Result<ExportEnvelope, String> {
    validate_export_password(password)?;

    let mut rng = rand::rngs::OsRng;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_export_key(password, &salt, PBKDF2_ITERATIONS);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {}", e))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| format!("Encryption failed: {}", e))?;

    Ok(ExportEnvelope {
        version,
        format: format.to_string(),
        cipher: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: PBKDF2_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
    })
}

/// Decrypt an [`ExportEnvelope`]. `expected_format` and `aad` must match what
/// the producer used — a wrong password, a tampered envelope, or an envelope
/// from a different export kind all fail with the same decryption error.
pub(crate) fn decrypt_envelope(
    envelope: ExportEnvelope,
    password: &str,
    expected_format: &str,
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    if envelope.format != expected_format
        || envelope.cipher != "AES-256-GCM"
        || envelope.kdf != "PBKDF2-HMAC-SHA256"
    {
        return Err("Unsupported export encryption parameters.".to_string());
    }
    if !(MIN_KDF_ITERATIONS..=MAX_KDF_ITERATIONS).contains(&envelope.iterations) {
        return Err("Export uses unsupported KDF iterations.".to_string());
    }
    let salt = BASE64
        .decode(envelope.salt)
        .map_err(|_| "Invalid export salt.".to_string())?;
    let nonce_bytes = BASE64
        .decode(envelope.nonce)
        .map_err(|_| "Invalid export nonce.".to_string())?;
    let ciphertext = BASE64
        .decode(envelope.data)
        .map_err(|_| "Invalid export data.".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("Invalid export nonce length.".to_string());
    }
    let key = derive_export_key(password, &salt, envelope.iterations);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {e}"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: ciphertext.as_ref(),
                aad,
            },
        )
        .map_err(|_| "Decryption failed. Incorrect password or modified file.".to_string())
}

/// Encrypt export bytes into the `tabler.export` envelope JSON for `kind`
/// ("table", "database", "bundle").
pub(crate) fn encrypt_export_payload(
    plaintext: &[u8],
    password: &str,
    kind: &str,
) -> Result<String, String> {
    let envelope = encrypt_envelope(plaintext, password, EXPORT_FORMAT, &export_aad(kind), 1)?;
    serde_json::to_string(&envelope)
        .map_err(|e| format!("Failed to serialize encrypted payload: {e}"))
}

/// Decrypt a `tabler.export` envelope for `kind`. Envelope shape, format, and
/// AAD are all verified; failures surface as the generic decryption error.
pub(crate) fn decrypt_export_payload(
    envelope_json: &str,
    password: &str,
    kind: &str,
) -> Result<Vec<u8>, String> {
    let value: serde_json::Value = serde_json::from_str(envelope_json)
        .map_err(|_| "Not a TableR encrypted export file.".to_string())?;
    if value.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("Unsupported encrypted export version.".to_string());
    }
    let envelope: ExportEnvelope = serde_json::from_value(value)
        .map_err(|e| format!("Invalid encrypted export envelope: {e}"))?;
    decrypt_envelope(envelope, password, EXPORT_FORMAT, &export_aad(kind))
}

/// Cheap JSON sniff: is this text a `tabler.export` envelope? Used by import
/// paths to decide whether to ask for a password before parsing the payload.
pub(crate) fn is_export_envelope(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|value| {
            value
                .get("format")
                .and_then(|f| f.as_str().map(str::to_owned))
        })
        .as_deref()
        == Some(EXPORT_FORMAT)
}

/// Error prefix the frontend matches to show the import password prompt.
pub(crate) const ENCRYPTED_EXPORT_CODE: &str = "TABLER_EXPORT_ENCRYPTED";

/// The file path an encrypted export is written to: `<chosen>.texp`, unless
/// the user already typed the suffix themselves.
pub(crate) fn encrypted_export_path(target: &std::path::Path) -> std::path::PathBuf {
    if target
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("texp"))
        .unwrap_or(false)
    {
        return target.to_path_buf();
    }
    let mut name = target
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".texp");
    target.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "correct horse battery";

    #[test]
    fn envelope_round_trips_and_stamps_the_spec_fields() {
        let plaintext = b"select * from secrets";
        let encrypted = encrypt_export_payload(plaintext, PASSWORD, "table").unwrap();
        let value: serde_json::Value = serde_json::from_str(&encrypted).unwrap();

        assert_eq!(value["version"], 1);
        assert_eq!(value["format"], "tabler.export");
        assert_eq!(value["cipher"], "AES-256-GCM");
        assert_eq!(value["kdf"], "PBKDF2-HMAC-SHA256");
        assert_eq!(value["iterations"], 600_000);

        assert_eq!(
            decrypt_export_payload(&encrypted, PASSWORD, "table").unwrap(),
            plaintext
        );
    }

    #[test]
    fn wrong_password_and_wrong_kind_fail_decryption() {
        let encrypted = encrypt_export_payload(b"data", PASSWORD, "table").unwrap();

        let error = decrypt_export_payload(&encrypted, "other-password!", "table").unwrap_err();
        assert!(error.contains("Incorrect password"));
        // The AAD binds ciphertext to the kind — a "bundle" decrypt must fail
        // even with the right password.
        let error = decrypt_export_payload(&encrypted, PASSWORD, "bundle").unwrap_err();
        assert!(error.contains("Incorrect password"));
    }

    #[test]
    fn short_password_is_refused() {
        let error = encrypt_export_payload(b"data", "short", "table").unwrap_err();
        assert!(error.contains("at least 10 characters"));
    }

    #[test]
    fn envelope_detection_ignores_plain_json() {
        assert!(is_export_envelope(
            &encrypt_export_payload(b"x", PASSWORD, "bundle").unwrap()
        ));
        assert!(!is_export_envelope(
            r#"{"format":"tabler.workspace-bundle"}"#
        ));
        assert!(!is_export_envelope("not json"));
    }

    #[test]
    fn encrypted_path_appends_texp_once() {
        let path = std::path::Path::new("C:/exports/users.csv");
        let encrypted = encrypted_export_path(path);
        assert_eq!(encrypted, std::path::Path::new("C:/exports/users.csv.texp"));
        // Already-suffixed paths are left alone.
        assert_eq!(encrypted_export_path(&encrypted), encrypted);
    }

    #[test]
    fn tampered_envelope_fails_authentication() {
        let encrypted = encrypt_export_payload(b"payload", PASSWORD, "database").unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&encrypted).unwrap();
        value["data"] = serde_json::json!(value["salt"].clone());
        let error = decrypt_export_payload(&value.to_string(), PASSWORD, "database").unwrap_err();
        assert!(error.contains("Incorrect password") || error.contains("Invalid export"));
    }
}
