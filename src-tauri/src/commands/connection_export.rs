//! Connection export/import with AES-256-GCM encryption.
//! File format: { version: "1", salt: base64, iv: base64, data: base64 }

use crate::database::models::{ConnectionConfig, DatabaseType, SslMode};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac_array;
use rand::RngCore;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;

const PBKDF2_V1_ITERATIONS: u32 = 100_000;
const PBKDF2_V2_ITERATIONS: u32 = 600_000;
const MIN_PASSWORD_LEN: usize = 10;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const EXPORT_AAD: &[u8] = b"tabler.connection-export.v2";
const EXPORT_FORMAT: &str = "tabler.connection-export";

#[derive(Serialize, Deserialize)]
struct EncryptedPayloadV1 {
    version: String,
    salt: String,
    iv: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayloadV2 {
    version: u8,
    format: String,
    cipher: String,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionExportDocument {
    version: u8,
    format: String,
    exported_at: String,
    connections: Vec<ExportableConnection>,
}

/// Derive a 256-bit key from password using PBKDF2-SHA256.
fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, iterations)
}

/// Encrypt connection data with the authenticated, versioned v2 envelope.
pub fn encrypt_connections(data: &str, password: &str) -> Result<String, String> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters."
        ));
    }

    let mut rng = rand::rngs::OsRng;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(password, &salt, PBKDF2_V2_ITERATIONS);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: data.as_bytes(),
                aad: EXPORT_AAD,
            },
        )
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let payload = EncryptedPayloadV2 {
        version: 2,
        format: EXPORT_FORMAT.to_string(),
        cipher: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: PBKDF2_V2_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
    };

    serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize encrypted payload: {}", e))
}

/// Decrypts v2 exports and supports v1 files as a migration path.
pub fn decrypt_connections(encrypted: &str, password: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(encrypted)
        .map_err(|e| format!("Invalid encrypted file format: {e}"))?;
    let version = value
        .get("version")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let plaintext = if version == serde_json::json!(2) {
        decrypt_v2(
            serde_json::from_value(value).map_err(|e| format!("Invalid v2 export: {e}"))?,
            password,
        )?
    } else if version == serde_json::json!("1") {
        decrypt_v1(
            serde_json::from_value(value).map_err(|e| format!("Invalid v1 export: {e}"))?,
            password,
        )?
    } else {
        return Err("Unsupported connection export version.".to_string());
    };

    String::from_utf8(plaintext).map_err(|e| format!("Decrypted data is not valid UTF-8: {e}"))
}

fn decrypt_v2(payload: EncryptedPayloadV2, password: &str) -> Result<Vec<u8>, String> {
    if payload.format != EXPORT_FORMAT
        || payload.cipher != "AES-256-GCM"
        || payload.kdf != "PBKDF2-HMAC-SHA256"
    {
        return Err("Unsupported v2 connection export parameters.".to_string());
    }
    if payload.iterations < PBKDF2_V1_ITERATIONS || payload.iterations > 2_000_000 {
        return Err("Connection export uses unsupported KDF iterations.".to_string());
    }
    let salt = BASE64
        .decode(payload.salt)
        .map_err(|_| "Invalid v2 export salt.".to_string())?;
    let nonce_bytes = BASE64
        .decode(payload.nonce)
        .map_err(|_| "Invalid v2 export nonce.".to_string())?;
    let ciphertext = BASE64
        .decode(payload.data)
        .map_err(|_| "Invalid v2 export data.".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("Invalid v2 export nonce length.".to_string());
    }
    let key = derive_key(password, &salt, payload.iterations);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {e}"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: ciphertext.as_ref(),
                aad: EXPORT_AAD,
            },
        )
        .map_err(|_| "Decryption failed. Incorrect password or modified file.".to_string())
}

fn decrypt_v1(payload: EncryptedPayloadV1, password: &str) -> Result<Vec<u8>, String> {
    let salt = BASE64
        .decode(payload.salt)
        .map_err(|_| "Invalid v1 export salt.".to_string())?;
    let nonce_bytes = BASE64
        .decode(payload.iv)
        .map_err(|_| "Invalid v1 export IV.".to_string())?;
    let ciphertext = BASE64
        .decode(payload.data)
        .map_err(|_| "Invalid v1 export data.".to_string())?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("Invalid v1 export IV length.".to_string());
    }
    let key = derive_key(password, &salt, PBKDF2_V1_ITERATIONS);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {e}"))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| "Decryption failed. Incorrect password or modified file.".to_string())
}

// ─── Serializable version of ConnectionConfig (excludes password and internal IDs) ───

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportableConnection {
    name: String,
    db_type: DatabaseType,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    database: Option<String>,
    file_path: Option<String>,
    use_ssl: bool,
    ssl_mode: Option<SslMode>,
    ssl_ca_cert_path: Option<String>,
    ssl_client_cert_path: Option<String>,
    ssl_client_key_path: Option<String>,
    ssl_skip_host_verification: Option<bool>,
    color: Option<String>,
    additional_fields: HashMap<String, String>,
    startup_commands: Option<String>,
}

impl From<&ConnectionConfig> for ExportableConnection {
    fn from(config: &ConnectionConfig) -> Self {
        Self {
            name: config.name.clone(),
            db_type: config.db_type,
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            database: config.database.clone(),
            file_path: config.file_path.clone(),
            use_ssl: config.use_ssl,
            ssl_mode: config.ssl_mode,
            ssl_ca_cert_path: config.ssl_ca_cert_path.clone(),
            ssl_client_cert_path: config.ssl_client_cert_path.clone(),
            ssl_client_key_path: config.ssl_client_key_path.clone(),
            ssl_skip_host_verification: config.ssl_skip_host_verification,
            color: config.color.clone(),
            additional_fields: config.additional_fields.clone(),
            startup_commands: config.startup_commands.clone(),
        }
    }
}

/// Export selected connections to an encrypted, versioned .tabler-connections file.
#[tauri::command]
pub fn export_connections_to_file(
    connections: Vec<ConnectionConfig>,
    password: String,
) -> Result<String, String> {
    if connections.is_empty() {
        return Err("No connections selected for export.".to_string());
    }
    if password.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters."
        ));
    }

    // Convert to exportable format (excludes password and internal IDs)
    let exportable: Vec<ExportableConnection> =
        connections.iter().map(ExportableConnection::from).collect();

    let document = ConnectionExportDocument {
        version: 2,
        format: EXPORT_FORMAT.to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        connections: exportable,
    };
    let json = serde_json::to_string(&document)
        .map_err(|e| format!("Failed to serialize connections: {}", e))?;

    let encrypted = encrypt_connections(&json, &password)?;

    let suggested_name = if connections.len() == 1 {
        let name = connections[0].name.trim();
        if !name.is_empty() {
            format!(
                "{}.tabler-connections",
                name.replace(
                    |c: char| !c.is_alphanumeric() && c != ' ' && c != '-' && c != '_',
                    "_"
                )
            )
        } else {
            "connections.tabler-connections".to_string()
        }
    } else {
        "connections.tabler-connections".to_string()
    };

    let path = FileDialog::new()
        .set_file_name(&suggested_name)
        .add_filter("TableR Connection Export", &["tabler-connections"])
        .save_file();

    match path {
        Some(file_path) => {
            std::fs::write(&file_path, &encrypted)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(file_path.to_string_lossy().to_string())
        }
        None => Err("No file selected.".to_string()),
    }
}

/// Imports v2 connection exports and transparently migrates legacy v1 files.
#[tauri::command]
pub fn import_connections_from_file(
    file_path: String,
    password: String,
) -> Result<Vec<ExportableConnection>, String> {
    let encrypted =
        std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let decrypted = decrypt_connections(&encrypted, &password)?;

    parse_decrypted_connections(&decrypted)
}

fn parse_decrypted_connections(decrypted: &str) -> Result<Vec<ExportableConnection>, String> {
    if let Ok(document) = serde_json::from_str::<ConnectionExportDocument>(decrypted) {
        if document.version != 2 || document.format != EXPORT_FORMAT {
            return Err("Unsupported decrypted connection export document.".to_string());
        }
        return Ok(document.connections);
    }

    serde_json::from_str::<Vec<ExportableConnection>>(decrypted).map_err(|e| {
        format!("Failed to parse connection data: {e}. Make sure the password is correct.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt_v1_fixture(data: &str, password: &str) -> String {
        let salt = [7_u8; SALT_LEN];
        let nonce_bytes = [9_u8; NONCE_LEN];
        let key = derive_key(password, &salt, PBKDF2_V1_ITERATIONS);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), data.as_bytes())
            .unwrap();
        serde_json::to_string(&EncryptedPayloadV1 {
            version: "1".to_string(),
            salt: BASE64.encode(salt),
            iv: BASE64.encode(nonce_bytes),
            data: BASE64.encode(ciphertext),
        })
        .unwrap()
    }

    #[test]
    fn v2_round_trip_uses_authenticated_envelope() {
        let exported = encrypt_connections("{\"hello\":true}", "correct horse battery").unwrap();
        let value: serde_json::Value = serde_json::from_str(&exported).unwrap();

        assert_eq!(value["version"], 2);
        assert_eq!(value["format"], EXPORT_FORMAT);
        assert_eq!(value["iterations"], PBKDF2_V2_ITERATIONS);
        assert_eq!(
            decrypt_connections(&exported, "correct horse battery").unwrap(),
            "{\"hello\":true}"
        );
    }

    #[test]
    fn v2_rejects_tampered_envelope_metadata() {
        let exported = encrypt_connections("secret", "correct horse battery").unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&exported).unwrap();
        value["format"] = serde_json::json!("other-format");

        assert!(decrypt_connections(&value.to_string(), "correct horse battery").is_err());
    }

    #[test]
    fn v1_payloads_remain_importable_for_migration() {
        let connection = ExportableConnection::from(&ConnectionConfig {
            name: "legacy".to_string(),
            ..ConnectionConfig::default()
        });
        let legacy_json = serde_json::to_string(&vec![connection]).unwrap();
        let exported = encrypt_v1_fixture(&legacy_json, "legacy-pass");
        let imported =
            parse_decrypted_connections(&decrypt_connections(&exported, "legacy-pass").unwrap())
                .unwrap();

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "legacy");
    }

    #[test]
    fn v2_document_round_trip_preserves_connections() {
        let document = ConnectionExportDocument {
            version: 2,
            format: EXPORT_FORMAT.to_string(),
            exported_at: "2026-07-15T00:00:00Z".to_string(),
            connections: vec![ExportableConnection::from(&ConnectionConfig {
                name: "production".to_string(),
                db_type: DatabaseType::PostgreSQL,
                host: Some("db.example.test".to_string()),
                ..ConnectionConfig::default()
            })],
        };
        let plaintext = serde_json::to_string(&document).unwrap();
        let encrypted = encrypt_connections(&plaintext, "correct horse battery").unwrap();
        let imported = parse_decrypted_connections(
            &decrypt_connections(&encrypted, "correct horse battery").unwrap(),
        )
        .unwrap();

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "production");
        assert_eq!(imported[0].host.as_deref(), Some("db.example.test"));
    }

    #[test]
    fn v2_requires_a_stronger_export_password() {
        assert!(encrypt_connections("secret", "short").is_err());
    }
}
