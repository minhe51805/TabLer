//! Connection export/import with AES-256-GCM encryption.
//! File format: { version: "1", salt: base64, iv: base64, data: base64 }

use std::collections::HashMap;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac_array;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use crate::database::models::{ConnectionConfig, DatabaseType, SslMode};
use rfd::FileDialog;

const PBKDF2_ITERATIONS: u32 = 100_000;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Serialize, Deserialize)]
struct EncryptedPayload {
    version: String,
    salt: String,
    iv: String,
    data: String,
}

/// Derive a 256-bit key from password using PBKDF2-SHA256.
fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, PBKDF2_ITERATIONS)
}

/// Encrypt connection data with AES-256-GCM. Returns a serialized EncryptedPayload.
pub fn encrypt_connections(data: &str, password: &str) -> Result<String, String> {
    if password.len() < 4 {
        return Err("Password must be at least 4 characters.".to_string());
    }

    let mut rng = rand::rngs::OsRng;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut salt);
    rng.fill(&mut nonce_bytes);

    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, data.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let payload = EncryptedPayload {
        version: "1".to_string(),
        salt: BASE64.encode(salt),
        iv: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
    };

    serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize encrypted payload: {}", e))
}

/// Decrypt an encrypted payload. Returns the decrypted string.
pub fn decrypt_connections(encrypted: &str, password: &str) -> Result<String, String> {
    let payload: EncryptedPayload =
        serde_json::from_str(encrypted).map_err(|e| format!("Invalid encrypted file format: {}", e))?;

    if payload.version != "1" {
        return Err(format!("Unsupported file version: {}", payload.version));
    }

    let salt = BASE64
        .decode(&payload.salt)
        .map_err(|e| format!("Invalid salt encoding: {}", e))?;
    let nonce_bytes = BASE64
        .decode(&payload.iv)
        .map_err(|e| format!("Invalid IV encoding: {}", e))?;
    let ciphertext = BASE64
        .decode(&payload.data)
        .map_err(|e| format!("Invalid ciphertext encoding: {}", e))?;

    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Decryption failed. Incorrect password.".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("Decrypted data is not valid UTF-8: {}", e))
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
            db_type: config.db_type.clone(),
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

/// Export selected connections to an encrypted .tablepro file.
#[tauri::command]
pub fn export_connections_to_file(
    connections: Vec<ConnectionConfig>,
    password: String,
) -> Result<String, String> {
    if connections.is_empty() {
        return Err("No connections selected for export.".to_string());
    }
    if password.len() < 4 {
        return Err("Password must be at least 4 characters.".to_string());
    }

    // Convert to exportable format (excludes password and internal IDs)
    let exportable: Vec<ExportableConnection> = connections
        .iter()
        .map(ExportableConnection::from)
        .collect();

    let json = serde_json::to_string(&exportable)
        .map_err(|e| format!("Failed to serialize connections: {}", e))?;

    let encrypted = encrypt_connections(&json, &password)?;

    let suggested_name = if connections.len() == 1 {
        let name = connections[0].name.trim();
        if !name.is_empty() {
            format!("{}.tablepro", name.replace(|c: char| !c.is_alphanumeric() && c != ' ' && c != '-' && c != '_', "_"))
        } else {
            "connections.tablepro".to_string()
        }
    } else {
        "connections.tablepro".to_string()
    };

    let path = FileDialog::new()
        .set_file_name(&suggested_name)
        .add_filter("TableR Connection File", &["tablepro"])
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

/// Import connections from an encrypted .tablepro file.
#[tauri::command]
pub fn import_connections_from_file(
    file_path: String,
    password: String,
) -> Result<Vec<ExportableConnection>, String> {
    let encrypted = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let decrypted = decrypt_connections(&encrypted, &password)?;

    let connections: Vec<ExportableConnection> = serde_json::from_str(&decrypted)
        .map_err(|e| format!("Failed to parse connection data: {}. Make sure the password is correct.", e))?;

    Ok(connections)
}
