use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac_array;
use rand::RngCore;
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use uuid::Uuid;

const SYNC_FORMAT: &str = "tabler.workspace-sync";
const SYNC_VERSION: u8 = 1;
const KDF_ITERATIONS: u32 = 600_000;
const MIN_PASSWORD_LENGTH: usize = 10;
const MAX_SYNC_BYTES: usize = 16 * 1024 * 1024;
const HISTORY_LIMIT: usize = 20;

fn local_sync_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkspaceSyncProvider {
    LocalFolder {
        directory: String,
    },
    WebDav {
        endpoint: String,
        username: Option<String>,
        password: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncVersion {
    pub revision: String,
    pub parent_revision: Option<String>,
    pub updated_at: String,
    pub device_id: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedWorkspaceSyncEnvelope {
    version: u8,
    format: String,
    workspace_id: String,
    revision: String,
    parent_revision: Option<String>,
    updated_at: String,
    device_id: String,
    cipher: String,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    data: String,
    #[serde(default)]
    history: Vec<WorkspaceSyncVersion>,
}

impl EncryptedWorkspaceSyncEnvelope {
    fn summary(&self) -> WorkspaceSyncVersion {
        WorkspaceSyncVersion {
            revision: self.revision.clone(),
            parent_revision: self.parent_revision.clone(),
            updated_at: self.updated_at.clone(),
            device_id: self.device_id.clone(),
            byte_length: self.data.len(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum WorkspaceSyncPushResult {
    #[serde(rename = "pushed")]
    Pushed { version: WorkspaceSyncVersion },
    #[serde(rename = "conflict")]
    Conflict {
        expected_revision: Option<String>,
        remote_version: WorkspaceSyncVersion,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncPullResult {
    pub bundle: String,
    pub version: WorkspaceSyncVersion,
    pub history: Vec<WorkspaceSyncVersion>,
}

struct ProviderObject {
    bytes: Vec<u8>,
    etag: Option<String>,
}

#[async_trait]
trait SyncProviderAdapter: Send + Sync {
    async fn read_current(&self, workspace_id: &str) -> Result<Option<ProviderObject>, String>;
    async fn read_history(
        &self,
        workspace_id: &str,
        revision: &str,
    ) -> Result<Option<ProviderObject>, String>;
    async fn write_current(
        &self,
        workspace_id: &str,
        bytes: &[u8],
        previous_etag: Option<&str>,
        creating: bool,
    ) -> Result<(), String>;
    async fn write_history(
        &self,
        workspace_id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<(), String>;
}

struct LocalFolderAdapter {
    root: PathBuf,
}

impl LocalFolderAdapter {
    fn new(directory: &str) -> Result<Self, String> {
        let root = PathBuf::from(directory);
        fs::create_dir_all(&root)
            .map_err(|e| format!("Failed to create local sync directory: {e}"))?;
        if !root.is_dir() {
            return Err("Local sync provider path is not a directory.".to_string());
        }
        Ok(Self { root })
    }

    fn current_path(&self, workspace_id: &str) -> PathBuf {
        self.root
            .join(format!("{workspace_id}.tableworkspace.sync"))
    }

    fn history_path(&self, workspace_id: &str, revision: &str) -> PathBuf {
        self.root
            .join(".tabler-history")
            .join(workspace_id)
            .join(format!("{revision}.sync"))
    }

    fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Sync destination has no parent directory.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create sync destination: {e}"))?;
        let temp = parent.join(format!(".tabler-sync-{}.tmp", Uuid::new_v4()));
        fs::write(&temp, bytes).map_err(|e| format!("Failed to write sync data: {e}"))?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("Failed to replace sync data: {e}"))?;
        }
        fs::rename(&temp, path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("Failed to activate sync data: {e}")
        })
    }
}

#[async_trait]
impl SyncProviderAdapter for LocalFolderAdapter {
    async fn read_current(&self, workspace_id: &str) -> Result<Option<ProviderObject>, String> {
        let path = self.current_path(workspace_id);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path).map_err(|e| format!("Failed to read local sync data: {e}"))?;
        if bytes.len() > MAX_SYNC_BYTES {
            return Err("Local sync data exceeds the size limit.".to_string());
        }
        Ok(Some(ProviderObject { bytes, etag: None }))
    }

    async fn read_history(
        &self,
        workspace_id: &str,
        revision: &str,
    ) -> Result<Option<ProviderObject>, String> {
        let path = self.history_path(workspace_id, revision);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path).map_err(|e| format!("Failed to read sync history: {e}"))?;
        Ok(Some(ProviderObject { bytes, etag: None }))
    }

    async fn write_current(
        &self,
        workspace_id: &str,
        bytes: &[u8],
        _previous_etag: Option<&str>,
        _creating: bool,
    ) -> Result<(), String> {
        Self::atomic_write(&self.current_path(workspace_id), bytes)
    }

    async fn write_history(
        &self,
        workspace_id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        Self::atomic_write(&self.history_path(workspace_id, revision), bytes)
    }
}

struct WebDavAdapter {
    client: Client,
    endpoint: Url,
    username: Option<String>,
    password: Option<String>,
}

impl WebDavAdapter {
    fn new(
        endpoint: &str,
        username: Option<String>,
        password: Option<String>,
    ) -> Result<Self, String> {
        let endpoint =
            Url::parse(endpoint).map_err(|_| "WebDAV endpoint is not a valid URL.".to_string())?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err(
                "WebDAV sync requires an HTTPS endpoint without embedded credentials.".to_string(),
            );
        }
        let client = Client::builder()
            .user_agent(concat!("TableR/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("Failed to create WebDAV client: {e}"))?;
        Ok(Self {
            client,
            endpoint,
            username,
            password,
        })
    }

    fn object_url(&self, segments: &[&str]) -> Result<Url, String> {
        let mut url = self.endpoint.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| "WebDAV endpoint cannot be used as a base URL.".to_string())?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    fn request(&self, method: reqwest::Method, url: Url) -> reqwest::RequestBuilder {
        let request = self.client.request(method, url);
        match self.username.as_deref() {
            Some(username) => request.basic_auth(username, self.password.as_deref()),
            None => request,
        }
    }

    async fn read_url(&self, url: Url) -> Result<Option<ProviderObject>, String> {
        let response = self
            .request(reqwest::Method::GET, url)
            .send()
            .await
            .map_err(|e| format!("WebDAV read failed: {e}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = response
            .error_for_status()
            .map_err(|e| format!("WebDAV read failed: {e}"))?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_SYNC_BYTES as u64)
        {
            return Err("WebDAV sync data exceeds the size limit.".to_string());
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read WebDAV response: {e}"))?;
        if bytes.len() > MAX_SYNC_BYTES {
            return Err("WebDAV sync data exceeds the size limit.".to_string());
        }
        Ok(Some(ProviderObject {
            bytes: bytes.to_vec(),
            etag,
        }))
    }
}

#[async_trait]
impl SyncProviderAdapter for WebDavAdapter {
    async fn read_current(&self, workspace_id: &str) -> Result<Option<ProviderObject>, String> {
        self.read_url(self.object_url(&[&format!("{workspace_id}.tableworkspace.sync")])?)
            .await
    }

    async fn read_history(
        &self,
        workspace_id: &str,
        revision: &str,
    ) -> Result<Option<ProviderObject>, String> {
        self.read_url(
            self.object_url(&[&format!(".tabler-history-{workspace_id}-{revision}.sync")])?,
        )
        .await
    }

    async fn write_current(
        &self,
        workspace_id: &str,
        bytes: &[u8],
        previous_etag: Option<&str>,
        creating: bool,
    ) -> Result<(), String> {
        let url = self.object_url(&[&format!("{workspace_id}.tableworkspace.sync")])?;
        let mut request = self
            .request(reqwest::Method::PUT, url)
            .header(
                header::CONTENT_TYPE,
                "application/vnd.tabler.workspace-sync+json",
            )
            .body(bytes.to_vec());
        if creating {
            request = request.header(header::IF_NONE_MATCH, "*");
        } else {
            let etag = previous_etag.ok_or_else(|| {
                "WebDAV server did not provide an ETag; safe conditional updates are unavailable."
                    .to_string()
            })?;
            request = request.header(header::IF_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("WebDAV write failed: {e}"))?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(
                "WebDAV object changed during the update; pull and resolve the conflict."
                    .to_string(),
            );
        }
        response
            .error_for_status()
            .map_err(|e| format!("WebDAV write failed: {e}"))?;
        Ok(())
    }

    async fn write_history(
        &self,
        workspace_id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let url = self.object_url(&[&format!(".tabler-history-{workspace_id}-{revision}.sync")])?;
        let response = self
            .request(reqwest::Method::PUT, url)
            .header(header::IF_NONE_MATCH, "*")
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| format!("Failed to archive WebDAV sync version: {e}"))?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(());
        }
        response
            .error_for_status()
            .map_err(|e| format!("Failed to archive WebDAV sync version: {e}"))?;
        Ok(())
    }
}

fn validate_workspace_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(
            "Workspace sync id may contain only letters, numbers, '-' and '_'.".to_string(),
        );
    }
    Ok(())
}

fn validate_revision(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Workspace sync revision is invalid.".to_string());
    }
    Ok(())
}

fn provider_adapter(
    provider: WorkspaceSyncProvider,
) -> Result<Box<dyn SyncProviderAdapter>, String> {
    match provider {
        WorkspaceSyncProvider::LocalFolder { directory } => {
            Ok(Box::new(LocalFolderAdapter::new(&directory)?))
        }
        WorkspaceSyncProvider::WebDav {
            endpoint,
            username,
            password,
        } => Ok(Box::new(WebDavAdapter::new(&endpoint, username, password)?)),
    }
}

fn parse_envelope(
    bytes: &[u8],
    workspace_id: &str,
) -> Result<EncryptedWorkspaceSyncEnvelope, String> {
    if bytes.len() > MAX_SYNC_BYTES {
        return Err("Workspace sync envelope exceeds the size limit.".to_string());
    }
    let envelope = serde_json::from_slice::<EncryptedWorkspaceSyncEnvelope>(bytes)
        .map_err(|e| format!("Workspace sync envelope is invalid: {e}"))?;
    if envelope.version != SYNC_VERSION
        || envelope.format != SYNC_FORMAT
        || envelope.workspace_id != workspace_id
        || envelope.cipher != "AES-256-GCM"
        || envelope.kdf != "PBKDF2-HMAC-SHA256"
        || envelope.iterations < 100_000
        || envelope.iterations > 2_000_000
    {
        return Err(
            "Workspace sync envelope is incompatible or targets another workspace.".to_string(),
        );
    }
    validate_revision(&envelope.revision)?;
    Ok(envelope)
}

fn encrypt_bundle(
    workspace_id: &str,
    bundle: &str,
    password: &str,
    parent_revision: Option<String>,
    device_id: String,
    history: Vec<WorkspaceSyncVersion>,
) -> Result<EncryptedWorkspaceSyncEnvelope, String> {
    if password.len() < MIN_PASSWORD_LENGTH {
        return Err(format!(
            "Workspace sync password must be at least {MIN_PASSWORD_LENGTH} characters."
        ));
    }
    if bundle.len() > MAX_SYNC_BYTES / 2 {
        return Err("Workspace bundle exceeds the sync size limit.".to_string());
    }
    let mut salt = [0u8; 32];
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let key = pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), &salt, KDF_ITERATIONS);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to initialize workspace encryption: {e}"))?;
    let aad = format!("{SYNC_FORMAT}.v{SYNC_VERSION}|{workspace_id}");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: bundle.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Failed to encrypt workspace bundle.".to_string())?;
    let revision = format!("{:x}", Sha256::digest(&ciphertext));
    Ok(EncryptedWorkspaceSyncEnvelope {
        version: SYNC_VERSION,
        format: SYNC_FORMAT.to_string(),
        workspace_id: workspace_id.to_string(),
        revision,
        parent_revision,
        updated_at: chrono::Utc::now().to_rfc3339(),
        device_id,
        cipher: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: KDF_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(ciphertext),
        history,
    })
}

fn decrypt_bundle(
    workspace_id: &str,
    envelope: &EncryptedWorkspaceSyncEnvelope,
    password: &str,
) -> Result<String, String> {
    let salt = BASE64
        .decode(&envelope.salt)
        .map_err(|_| "Workspace sync salt is invalid.".to_string())?;
    let nonce = BASE64
        .decode(&envelope.nonce)
        .map_err(|_| "Workspace sync nonce is invalid.".to_string())?;
    let ciphertext = BASE64
        .decode(&envelope.data)
        .map_err(|_| "Workspace sync ciphertext is invalid.".to_string())?;
    if salt.len() != 32 || nonce.len() != 12 {
        return Err("Workspace sync cryptographic metadata is invalid.".to_string());
    }
    if format!("{:x}", Sha256::digest(&ciphertext)) != envelope.revision {
        return Err("Workspace sync revision does not match its encrypted payload.".to_string());
    }
    let key = pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), &salt, envelope.iterations);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to initialize workspace decryption: {e}"))?;
    let aad = format!("{SYNC_FORMAT}.v{SYNC_VERSION}|{workspace_id}");
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| {
            "Workspace decryption failed. Check the password and remote data.".to_string()
        })?;
    String::from_utf8(plaintext).map_err(|_| "Decrypted workspace is not valid UTF-8.".to_string())
}

#[tauri::command]
pub async fn push_workspace_sync(
    provider: WorkspaceSyncProvider,
    workspace_id: String,
    bundle: String,
    password: String,
    device_id: String,
    expected_revision: Option<String>,
) -> Result<WorkspaceSyncPushResult, String> {
    validate_workspace_id(&workspace_id)?;
    if let Some(revision) = expected_revision.as_deref() {
        validate_revision(revision)?;
    }
    if device_id.trim().is_empty() || device_id.len() > 120 {
        return Err("Workspace sync device id is invalid.".to_string());
    }
    let adapter = provider_adapter(provider)?;
    let _sync_guard = local_sync_guard().lock().await;
    let current_object = adapter.read_current(&workspace_id).await?;
    let current = current_object
        .as_ref()
        .map(|object| parse_envelope(&object.bytes, &workspace_id))
        .transpose()?;
    let remote_revision = current.as_ref().map(|envelope| envelope.revision.clone());
    if remote_revision != expected_revision {
        if let Some(remote) = current {
            return Ok(WorkspaceSyncPushResult::Conflict {
                expected_revision,
                remote_version: remote.summary(),
            });
        }
        return Err("Expected a remote revision, but the workspace no longer exists.".to_string());
    }

    let mut history = current
        .as_ref()
        .map(|envelope| envelope.history.clone())
        .unwrap_or_default();
    if let (Some(object), Some(envelope)) = (&current_object, &current) {
        adapter
            .write_history(&workspace_id, &envelope.revision, &object.bytes)
            .await?;
        history.push(envelope.summary());
        if history.len() > HISTORY_LIMIT {
            history.drain(..history.len() - HISTORY_LIMIT);
        }
    }
    let envelope = encrypt_bundle(
        &workspace_id,
        &bundle,
        &password,
        remote_revision,
        device_id,
        history,
    )?;
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|e| format!("Failed to serialize workspace sync envelope: {e}"))?;
    adapter
        .write_current(
            &workspace_id,
            &bytes,
            current_object
                .as_ref()
                .and_then(|object| object.etag.as_deref()),
            current_object.is_none(),
        )
        .await?;
    Ok(WorkspaceSyncPushResult::Pushed {
        version: envelope.summary(),
    })
}

#[tauri::command]
pub async fn pull_workspace_sync(
    provider: WorkspaceSyncProvider,
    workspace_id: String,
    password: String,
    revision: Option<String>,
) -> Result<WorkspaceSyncPullResult, String> {
    validate_workspace_id(&workspace_id)?;
    let adapter = provider_adapter(provider)?;
    let object = match revision.as_deref() {
        Some(revision) => {
            validate_revision(revision)?;
            adapter.read_history(&workspace_id, revision).await?
        }
        None => adapter.read_current(&workspace_id).await?,
    }
    .ok_or_else(|| "Workspace sync object was not found.".to_string())?;
    let envelope = parse_envelope(&object.bytes, &workspace_id)?;
    let bundle = decrypt_bundle(&workspace_id, &envelope, &password)?;
    Ok(WorkspaceSyncPullResult {
        bundle,
        version: envelope.summary(),
        history: envelope.history,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_workspace_round_trip_is_authenticated() {
        let envelope = encrypt_bundle(
            "workspace-1",
            "{\"format\":\"tabler-workspace\"}",
            "correct horse battery",
            None,
            "test-device".to_string(),
            vec![],
        )
        .unwrap();
        assert_eq!(
            decrypt_bundle("workspace-1", &envelope, "correct horse battery").unwrap(),
            "{\"format\":\"tabler-workspace\"}"
        );
        assert!(decrypt_bundle("workspace-2", &envelope, "correct horse battery").is_err());
        assert!(decrypt_bundle("workspace-1", &envelope, "wrong password").is_err());
    }

    #[test]
    fn local_provider_keeps_reversible_history() {
        let root = std::env::temp_dir().join(format!("tabler-sync-test-{}", Uuid::new_v4()));
        let adapter = LocalFolderAdapter::new(root.to_str().unwrap()).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            adapter
                .write_current("workspace", b"current", None, true)
                .await
                .unwrap();
            adapter
                .write_history("workspace", &"a".repeat(64), b"previous")
                .await
                .unwrap();
            assert_eq!(
                adapter
                    .read_history("workspace", &"a".repeat(64))
                    .await
                    .unwrap()
                    .unwrap()
                    .bytes,
                b"previous"
            );
        });
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsafe_workspace_ids_and_insecure_webdav() {
        assert!(validate_workspace_id("team_workspace-1").is_ok());
        assert!(validate_workspace_id("../secrets").is_err());
        assert!(WebDavAdapter::new("http://example.com/dav", None, None).is_err());
        assert!(WebDavAdapter::new("https://user:pass@example.com/dav", None, None).is_err());
    }
}
