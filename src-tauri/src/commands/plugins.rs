use crate::database::manager::DatabaseManager;
use crate::storage::plugin_storage::{InstalledPluginRecord, PluginManifest, PluginStorage};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use rfd::FileDialog;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::task;
use uuid::Uuid;

const PLUGIN_API_VERSION: u32 = 1;
const MAX_PLUGIN_FILES: usize = 512;
const MAX_PLUGIN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_PLUGIN_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/minhe51805/TabLer/main/plugin-registry.json";
const ALLOWED_KINDS: &[&str] = &[
    "tooling",
    "adapter",
    "visualization",
    "ai",
    "export",
    "import",
    "theme",
    "extension",
];
const ALLOWED_CAPABILITIES: &[&str] = &[
    "commands",
    "database",
    "export",
    "import",
    "sidebar",
    "ai",
    "theme",
    "autocomplete",
    "file",
];
const ALLOWED_PERMISSIONS: &[&str] = &[
    "workspace.read",
    "connection.metadata",
    "query.read",
    "query.execute",
    "network.fetch",
    "file.read",
    "file.write",
    "clipboard.write",
    "notifications",
];

#[derive(Debug)]
struct ValidatedBundle {
    manifest: PluginManifest,
    digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ActivePluginDriver {
    pub plugin_id: String,
    pub contribution: crate::storage::plugin_storage::PluginDriverContribution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryAsset {
    pub path: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryPackage {
    pub manifest: PluginManifest,
    #[serde(default)]
    pub assets: Vec<PluginRegistryAsset>,
    pub published_at: Option<String>,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryIndex {
    pub schema_version: u32,
    pub generated_at: String,
    #[serde(default)]
    pub packages: Vec<PluginRegistryPackage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateCandidate {
    pub plugin_id: String,
    pub installed_version: String,
    pub available_version: String,
    pub package: PluginRegistryPackage,
}

async fn run_blocking_plugin_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background plugin task failed unexpectedly.".to_string())?
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn slugify_plugin_id(value: &str) -> String {
    let mut slug = String::with_capacity(value.len());
    let mut previous_was_separator = false;

    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            previous_was_separator = false;
        } else if !previous_was_separator {
            slug.push('-');
            previous_was_separator = true;
        }
    }

    slug.trim_matches('-').to_string()
}

fn resolve_bundle_source(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let direct_manifest = root.join("plugin.json");
    if direct_manifest.is_file() {
        return Ok((root.to_path_buf(), direct_manifest));
    }

    let nested_bundle = root.join(".tableplugin");
    let nested_manifest = nested_bundle.join("plugin.json");
    if nested_manifest.is_file() {
        return Ok((nested_bundle, nested_manifest));
    }

    Err("Selected folder is not a valid TableR plugin bundle.".to_string())
}

fn read_plugin_manifest(manifest_path: &Path) -> Result<PluginManifest, String> {
    let raw = fs::read_to_string(manifest_path)
        .map_err(|e| format!("Failed to read plugin manifest: {e}"))?;
    let mut manifest = serde_json::from_str::<PluginManifest>(&raw)
        .map_err(|e| format!("Failed to parse plugin manifest: {e}"))?;

    manifest.id = if manifest.id.trim().is_empty() {
        slugify_plugin_id(&manifest.name)
    } else {
        slugify_plugin_id(&manifest.id)
    };
    manifest.name = manifest.name.trim().to_string();
    manifest.kind = manifest.kind.trim().to_ascii_lowercase();
    manifest.capabilities = normalize_declarations(&manifest.capabilities);
    manifest.permissions = normalize_declarations(&manifest.permissions);

    Ok(manifest)
}

fn normalize_declarations(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn validate_relative_path(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!("Plugin {label} must be a non-empty relative path."));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Plugin {label} cannot escape the bundle directory."
        ));
    }
    Ok(path.to_path_buf())
}

fn validate_manifest_metadata(manifest: &PluginManifest) -> Result<(), String> {
    if manifest.api_version != PLUGIN_API_VERSION {
        return Err(format!(
            "Plugin API version {} is unsupported; TableR supports version {}.",
            manifest.api_version, PLUGIN_API_VERSION
        ));
    }
    if manifest.id.is_empty() || manifest.name.is_empty() {
        return Err("Plugin manifest requires a non-empty id and name.".to_string());
    }
    Version::parse(&manifest.version)
        .map_err(|_| "Plugin manifest version must use semantic versioning.".to_string())?;
    if !ALLOWED_KINDS.contains(&manifest.kind.as_str()) {
        return Err(format!("Unsupported plugin kind '{}'.", manifest.kind));
    }

    for capability in &manifest.capabilities {
        if !ALLOWED_CAPABILITIES.contains(&capability.as_str()) {
            return Err(format!("Unknown plugin capability '{capability}'."));
        }
    }
    for permission in &manifest.permissions {
        if !ALLOWED_PERMISSIONS.contains(&permission.as_str()) {
            return Err(format!("Unknown plugin permission '{permission}'."));
        }
    }

    validate_contributions(manifest)?;

    let required_capability = match manifest.kind.as_str() {
        "adapter" => Some("database"),
        "export" => Some("export"),
        "import" => Some("import"),
        "ai" => Some("ai"),
        "theme" => Some("theme"),
        _ => None,
    };
    if let Some(required) = required_capability {
        if !manifest.capabilities.iter().any(|value| value == required) {
            return Err(format!(
                "Plugin kind '{}' requires the '{}' capability.",
                manifest.kind, required
            ));
        }
    }

    validate_compatibility_metadata(manifest)?;
    let integrity = manifest
        .integrity
        .as_ref()
        .ok_or_else(|| "Plugin manifest requires integrity metadata.".to_string())?;
    if !integrity.algorithm.eq_ignore_ascii_case("sha256") {
        return Err("Plugin integrity algorithm must be 'sha256'.".to_string());
    }
    if integrity.digest.len() != 64
        || !integrity
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(
            "Plugin integrity digest must be a 64-character SHA-256 hex value.".to_string(),
        );
    }

    Ok(())
}

fn validate_manifest(manifest: &PluginManifest, bundle_dir: &Path) -> Result<(), String> {
    validate_manifest_metadata(manifest)?;
    validate_compatibility(manifest)?;
    if let Some(entry) = manifest.entry.as_deref() {
        let relative = validate_relative_path(entry, "entry")?;
        let entry_path = bundle_dir.join(relative);
        if !entry_path.is_file() {
            return Err(format!("Plugin entry '{}' does not exist.", entry));
        }
    }
    Ok(())
}

fn validate_contributions(manifest: &PluginManifest) -> Result<(), String> {
    if manifest.contributes.formats.len() > 32 || manifest.contributes.drivers.len() > 16 {
        return Err("Plugin declares too many contributions.".to_string());
    }
    if !manifest.contributes.formats.is_empty()
        && !manifest
            .capabilities
            .iter()
            .any(|capability| capability == "export" || capability == "import")
    {
        return Err(
            "Format contributions require the 'export' or 'import' capability.".to_string(),
        );
    }
    if !manifest.contributes.drivers.is_empty()
        && !manifest
            .capabilities
            .iter()
            .any(|capability| capability == "database")
    {
        return Err("Driver contributions require the 'database' capability.".to_string());
    }

    let mut ids = HashSet::new();
    for format in &manifest.contributes.formats {
        let id = slugify_plugin_id(&format.id);
        if id != format.id || id.is_empty() || !ids.insert(format.id.as_str()) {
            return Err(format!("Invalid or duplicate format id '{}'.", format.id));
        }
        if format.label.trim().is_empty() || format.label.len() > 80 {
            return Err(format!("Format '{}' requires a concise label.", format.id));
        }
        if format.extension.is_empty()
            || format.extension.len() > 12
            || !format
                .extension
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(format!("Format '{}' has an invalid extension.", format.id));
        }
        if !format.mime_type.contains('/') || format.mime_type.len() > 100 {
            return Err(format!("Format '{}' has an invalid MIME type.", format.id));
        }
        match format.mode.as_str() {
            "delimited" => {
                let delimiter = format.delimiter.as_deref().ok_or_else(|| {
                    format!("Delimited format '{}' requires a delimiter.", format.id)
                })?;
                if delimiter.chars().count() != 1 || delimiter == "\r" || delimiter == "\n" {
                    return Err(format!(
                        "Format '{}' requires one safe delimiter character.",
                        format.id
                    ));
                }
            }
            "json-lines" => {
                if format.delimiter.is_some() {
                    return Err(format!(
                        "JSON Lines format '{}' cannot declare a delimiter.",
                        format.id
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "Format '{}' uses an unsupported runtime mode.",
                    format.id
                ))
            }
        }
    }

    for driver in &manifest.contributes.drivers {
        let id = slugify_plugin_id(&driver.id);
        if id != driver.id || id.is_empty() || !ids.insert(driver.id.as_str()) {
            return Err(format!("Invalid or duplicate driver id '{}'.", driver.id));
        }
        if driver.protocol.trim().is_empty() || driver.label.trim().is_empty() {
            return Err(format!("Driver '{}' metadata is incomplete.", driver.id));
        }
        match (driver.runtime.as_str(), driver.status.as_str()) {
            ("wasm-component-v1", "experimental") => {}
            ("declarative-http-v1", "stable") => {
                if driver.protocol != "opensearch" {
                    return Err(format!(
                        "Driver '{}' uses a protocol unsupported by declarative-http-v1.",
                        driver.id
                    ));
                }
                for permission in [
                    "connection.metadata",
                    "query.read",
                    "query.execute",
                    "network.fetch",
                ] {
                    if !manifest.permissions.iter().any(|value| value == permission) {
                        return Err(format!(
                            "Driver '{}' requires the '{}' permission.",
                            driver.id, permission
                        ));
                    }
                }
            }
            _ => {
                return Err(format!(
                    "Driver '{}' declares an unsupported runtime/status pair.",
                    driver.id
                ))
            }
        }
    }

    Ok(())
}

fn validate_compatibility(manifest: &PluginManifest) -> Result<(), String> {
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "TableR app version is invalid.".to_string())?;
    if let Some(minimum) = manifest.compatibility.min_app_version.as_deref() {
        let minimum = Version::parse(minimum)
            .map_err(|_| "Plugin minAppVersion must use semantic versioning.".to_string())?;
        if current < minimum {
            return Err(format!("Plugin requires TableR {minimum} or newer."));
        }
    }
    if let Some(maximum) = manifest.compatibility.max_app_version.as_deref() {
        let maximum = Version::parse(maximum)
            .map_err(|_| "Plugin maxAppVersion must use semantic versioning.".to_string())?;
        if current > maximum {
            return Err(format!("Plugin supports TableR up to {maximum}."));
        }
    }

    let platform = std::env::consts::OS.to_ascii_lowercase();
    if !manifest.compatibility.platforms.is_empty()
        && !manifest
            .compatibility
            .platforms
            .iter()
            .any(|value| value.eq_ignore_ascii_case(&platform))
    {
        return Err(format!(
            "Plugin does not support the '{platform}' platform."
        ));
    }
    let architecture = std::env::consts::ARCH.to_ascii_lowercase();
    if !manifest.compatibility.architectures.is_empty()
        && !manifest
            .compatibility
            .architectures
            .iter()
            .any(|value| value.eq_ignore_ascii_case(&architecture))
    {
        return Err(format!(
            "Plugin does not support the '{architecture}' architecture."
        ));
    }

    Ok(())
}

fn validate_compatibility_metadata(manifest: &PluginManifest) -> Result<(), String> {
    if let Some(minimum) = manifest.compatibility.min_app_version.as_deref() {
        Version::parse(minimum)
            .map_err(|_| "Plugin minAppVersion must use semantic versioning.".to_string())?;
    }
    if let Some(maximum) = manifest.compatibility.max_app_version.as_deref() {
        Version::parse(maximum)
            .map_err(|_| "Plugin maxAppVersion must use semantic versioning.".to_string())?;
    }
    if manifest
        .compatibility
        .platforms
        .iter()
        .chain(manifest.compatibility.architectures.iter())
        .any(|value| value.trim().is_empty() || value.len() > 32)
    {
        return Err("Plugin compatibility targets contain an invalid value.".to_string());
    }
    Ok(())
}

fn collect_bundle_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| {
        format!(
            "Failed to read plugin directory '{}': {e}",
            directory.display()
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read plugin bundle entry: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("Failed to inspect plugin bundle entry: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin bundles cannot contain symbolic links.".to_string());
        }
        if metadata.is_dir() {
            collect_bundle_files(root, &entry.path(), files)?;
        } else if metadata.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Plugin file escaped the bundle root.".to_string())?
                .to_path_buf();
            files.push(relative);
            if files.len() > MAX_PLUGIN_FILES {
                return Err(format!("Plugin bundle exceeds {MAX_PLUGIN_FILES} files."));
            }
        }
    }
    Ok(())
}

fn compute_bundle_digest(bundle_dir: &Path, manifest: &PluginManifest) -> Result<String, String> {
    let mut files = Vec::new();
    collect_bundle_files(bundle_dir, bundle_dir, &mut files)?;
    files.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));

    let mut hasher = Sha256::new();
    let mut semantic_manifest = manifest.clone();
    semantic_manifest.integrity = None;
    let manifest_bytes = serde_json::to_vec(&semantic_manifest)
        .map_err(|e| format!("Failed to normalize plugin manifest: {e}"))?;
    hasher.update(b"plugin.json\0");
    hasher.update((manifest_bytes.len() as u64).to_le_bytes());
    hasher.update(&manifest_bytes);

    let mut total_bytes = manifest_bytes.len() as u64;
    for relative in files {
        if relative == Path::new("plugin.json") {
            continue;
        }
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let mut file = fs::File::open(bundle_dir.join(&relative))
            .map_err(|e| format!("Failed to open plugin file '{normalized}': {e}"))?;
        let file_len = file
            .metadata()
            .map_err(|e| format!("Failed to inspect plugin file '{normalized}': {e}"))?
            .len();
        total_bytes = total_bytes.saturating_add(file_len);
        if total_bytes > MAX_PLUGIN_BYTES {
            return Err(format!(
                "Plugin bundle exceeds {} MiB.",
                MAX_PLUGIN_BYTES / 1024 / 1024
            ));
        }
        hasher.update(normalized.as_bytes());
        hasher.update([0]);
        hasher.update(file_len.to_le_bytes());
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| format!("Failed to hash plugin file '{normalized}': {e}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_bundle(bundle_dir: &Path) -> Result<ValidatedBundle, String> {
    let manifest = read_plugin_manifest(&bundle_dir.join("plugin.json"))?;
    validate_manifest(&manifest, bundle_dir)?;
    let digest = compute_bundle_digest(bundle_dir, &manifest)?;
    let expected = manifest
        .integrity
        .as_ref()
        .expect("integrity is checked above")
        .digest
        .to_ascii_lowercase();
    if digest != expected {
        return Err(format!(
            "Plugin integrity check failed (expected {expected}, computed {digest})."
        ));
    }
    Ok(ValidatedBundle { manifest, digest })
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "Plugin bundle source '{}' does not exist.",
            source.display()
        ));
    }
    fs::create_dir_all(destination).map_err(|e| {
        format!(
            "Failed to create plugin destination '{}': {e}",
            destination.display()
        )
    })?;
    for entry in fs::read_dir(source).map_err(|e| {
        format!(
            "Failed to read plugin bundle directory '{}': {e}",
            source.display()
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read plugin bundle entry: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("Failed to inspect plugin bundle entry: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin bundles cannot contain symbolic links.".to_string());
        }
        let destination_path = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_dir_recursive(&entry.path(), &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &destination_path).map_err(|e| {
                format!(
                    "Failed to copy plugin file '{}': {e}",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove plugin bundle '{}': {e}", path.display()))?;
    }
    Ok(())
}

fn rollback_path(storage: &PluginStorage, plugin_id: &str) -> PathBuf {
    storage
        .rollback_dir()
        .join(format!("{plugin_id}.tableplugin"))
}

fn verify_installed_record(mut record: InstalledPluginRecord) -> InstalledPluginRecord {
    match validate_bundle(Path::new(&record.bundle_path)) {
        Ok(validated) if validated.manifest.id == record.manifest.id => {
            record.manifest = validated.manifest;
            record.computed_integrity = Some(validated.digest);
            record.verified = true;
            record.validation_error = None;
        }
        Ok(_) => {
            record.enabled = false;
            record.verified = false;
            record.validation_error =
                Some("Installed plugin id no longer matches its record.".to_string());
        }
        Err(error) => {
            record.enabled = false;
            record.verified = false;
            record.validation_error = Some(error);
        }
    }
    record
}

fn sync_installed_plugins(storage: &PluginStorage) -> Result<Vec<InstalledPluginRecord>, String> {
    let records = storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
    let now = now_unix_seconds();
    let synced = records
        .into_iter()
        .filter(|record| Path::new(&record.bundle_path).is_dir())
        .map(|mut record| {
            record.updated_at = now;
            record.rollback_available = rollback_path(storage, &record.manifest.id).is_dir();
            verify_installed_record(record)
        })
        .collect::<Vec<_>>();
    storage
        .save_plugins(&synced)
        .map_err(|e| format!("Failed to save installed plugins: {e}"))?;
    Ok(synced)
}

pub(crate) fn resolve_active_plugin_driver(
    storage: &PluginStorage,
    plugin_id: &str,
    driver_id: &str,
) -> Result<ActivePluginDriver, String> {
    let bundle_root = storage
        .bundles_dir()
        .canonicalize()
        .map_err(|e| format!("Failed to inspect the plugin bundle directory: {e}"))?;
    let records = sync_installed_plugins(storage)?;
    let record = records
        .into_iter()
        .find(|record| record.manifest.id == plugin_id)
        .ok_or_else(|| format!("Required driver plugin '{plugin_id}' is not installed."))?;

    let installed_path = Path::new(&record.bundle_path)
        .canonicalize()
        .map_err(|e| format!("Failed to inspect driver plugin '{plugin_id}': {e}"))?;
    if !installed_path.starts_with(&bundle_root) {
        return Err(format!(
            "Driver plugin '{plugin_id}' is outside the managed plugin directory."
        ));
    }
    if !record.enabled || !record.verified || record.validation_error.is_some() {
        return Err(format!(
            "Driver plugin '{plugin_id}' must be enabled and verified before use."
        ));
    }
    if !record
        .manifest
        .capabilities
        .iter()
        .any(|capability| capability == "database")
    {
        return Err(format!(
            "Driver plugin '{plugin_id}' did not declare the database capability."
        ));
    }

    let contribution = record
        .manifest
        .contributes
        .drivers
        .into_iter()
        .find(|driver| driver.id == driver_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide driver '{driver_id}'."))?;
    Ok(ActivePluginDriver {
        plugin_id: record.manifest.id,
        contribution,
    })
}

fn install_bundle_from_path(
    storage: &PluginStorage,
    source_bundle_dir: &Path,
) -> Result<InstalledPluginRecord, String> {
    let source = validate_bundle(source_bundle_dir)?;
    let staging = storage
        .staging_dir()
        .join(format!("{}-{}", source.manifest.id, Uuid::new_v4()));
    copy_dir_recursive(source_bundle_dir, &staging)?;
    let staged = match validate_bundle(&staging) {
        Ok(bundle) => bundle,
        Err(error) => {
            let _ = remove_dir_if_exists(&staging);
            return Err(error);
        }
    };

    let destination = storage
        .bundles_dir()
        .join(format!("{}.tableplugin", staged.manifest.id));
    let rollback = rollback_path(storage, &staged.manifest.id);
    let mut records = storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
    let existing = records
        .iter()
        .find(|record| record.manifest.id == staged.manifest.id)
        .cloned();

    remove_dir_if_exists(&rollback)?;
    if destination.exists() {
        fs::rename(&destination, &rollback)
            .map_err(|e| format!("Failed to preserve the previous plugin version: {e}"))?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if rollback.exists() {
            let _ = fs::rename(&rollback, &destination);
        }
        let _ = remove_dir_if_exists(&staging);
        return Err(format!(
            "Failed to activate the staged plugin bundle: {error}"
        ));
    }

    let now = now_unix_seconds();
    let record = InstalledPluginRecord {
        manifest: staged.manifest,
        bundle_path: destination.to_string_lossy().to_string(),
        enabled: true,
        installed_at: existing.as_ref().map_or(now, |record| record.installed_at),
        updated_at: now,
        verified: true,
        computed_integrity: Some(staged.digest),
        validation_error: None,
        rollback_available: existing.is_some(),
        previous_version: existing.map(|record| record.manifest.version),
    };

    if let Some(index) = records
        .iter()
        .position(|existing| existing.manifest.id == record.manifest.id)
    {
        records[index] = record.clone();
    } else {
        records.push(record.clone());
    }
    if let Err(error) = storage.save_plugins(&records) {
        let _ = remove_dir_if_exists(&destination);
        if rollback.exists() {
            let _ = fs::rename(&rollback, &destination);
        }
        return Err(format!("Failed to save installed plugins: {error}"));
    }
    Ok(record)
}

fn validate_https_url(value: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| format!("{label} is not a valid URL."))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(format!("{label} must use HTTPS."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} cannot contain embedded credentials."));
    }
    Ok(url)
}

async fn download_limited(
    client: &Client,
    url: Url,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {label}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to download {label}: {e}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!("{label} exceeds the allowed download size."));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed while downloading {label}: {e}"))?;
        if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(format!("{label} exceeds the allowed download size."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn registry_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("TableR/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to create plugin registry client: {e}"))
}

fn validate_registry(index: &PluginRegistryIndex) -> Result<(), String> {
    if index.schema_version != 1 {
        return Err(format!(
            "Unsupported plugin registry schema version {}.",
            index.schema_version
        ));
    }
    if index.packages.len() > 500 {
        return Err("Plugin registry contains too many packages.".to_string());
    }

    let mut versions = HashSet::new();
    for package in &index.packages {
        let manifest = &package.manifest;
        if manifest.id != slugify_plugin_id(&manifest.id) || manifest.id.is_empty() {
            return Err(format!("Registry plugin id '{}' is invalid.", manifest.id));
        }
        Version::parse(&manifest.version).map_err(|_| {
            format!(
                "Registry plugin '{}' has an invalid semantic version.",
                manifest.id
            )
        })?;
        let version_key = format!("{}@{}", manifest.id, manifest.version);
        if !versions.insert(version_key) {
            return Err(format!(
                "Registry contains duplicate plugin version '{}@{}'.",
                manifest.id, manifest.version
            ));
        }
        validate_manifest_metadata(manifest)?;

        if package.assets.len() > MAX_PLUGIN_FILES {
            return Err(format!(
                "Plugin '{}' declares too many assets.",
                manifest.id
            ));
        }
        let mut asset_paths = HashSet::new();
        let mut total_size = 0u64;
        for asset in &package.assets {
            let path = validate_relative_path(&asset.path, "registry asset")?;
            if path == Path::new("plugin.json") || !asset_paths.insert(path) {
                return Err(format!(
                    "Plugin '{}' has duplicate or reserved assets.",
                    manifest.id
                ));
            }
            validate_https_url(&asset.url, "Plugin asset URL")?;
            if asset.sha256.len() != 64
                || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(format!(
                    "Plugin '{}' has an invalid asset hash.",
                    manifest.id
                ));
            }
            total_size = total_size.saturating_add(asset.size);
            if total_size > MAX_PLUGIN_BYTES {
                return Err(format!(
                    "Plugin '{}' assets exceed the size limit.",
                    manifest.id
                ));
            }
        }
        if let Some(entry) = manifest.entry.as_deref() {
            let entry = validate_relative_path(entry, "entry")?;
            if !asset_paths.contains(&entry) {
                return Err(format!(
                    "Plugin '{}' entry is missing from registry assets.",
                    manifest.id
                ));
            }
        }
    }
    Ok(())
}

async fn fetch_registry_index(registry_url: Option<String>) -> Result<PluginRegistryIndex, String> {
    let raw_url = registry_url
        .as_deref()
        .unwrap_or(DEFAULT_PLUGIN_REGISTRY_URL);
    let url = validate_https_url(raw_url, "Plugin registry URL")?;
    let client = registry_client()?;
    let bytes = download_limited(&client, url, MAX_REGISTRY_BYTES, "plugin registry").await?;
    let index = serde_json::from_slice::<PluginRegistryIndex>(&bytes)
        .map_err(|e| format!("Plugin registry JSON is invalid: {e}"))?;
    validate_registry(&index)?;
    Ok(index)
}

fn latest_compatible_package<'a>(
    index: &'a PluginRegistryIndex,
    plugin_id: &str,
) -> Result<&'a PluginRegistryPackage, String> {
    index
        .packages
        .iter()
        .filter(|package| {
            package.manifest.id == plugin_id && validate_compatibility(&package.manifest).is_ok()
        })
        .max_by(|left, right| {
            let left_version =
                Version::parse(&left.manifest.version).unwrap_or(Version::new(0, 0, 0));
            let right_version =
                Version::parse(&right.manifest.version).unwrap_or(Version::new(0, 0, 0));
            left_version.cmp(&right_version)
        })
        .ok_or_else(|| format!("Plugin '{plugin_id}' is not available in this registry."))
}

async fn materialize_registry_package(
    storage: &PluginStorage,
    package: &PluginRegistryPackage,
) -> Result<PathBuf, String> {
    let source = storage.staging_dir().join(format!(
        "registry-{}-{}",
        package.manifest.id,
        Uuid::new_v4()
    ));
    fs::create_dir_all(&source)
        .map_err(|e| format!("Failed to create plugin download directory: {e}"))?;
    let manifest_json = serde_json::to_vec_pretty(&package.manifest)
        .map_err(|e| format!("Failed to serialize registry manifest: {e}"))?;
    fs::write(source.join("plugin.json"), manifest_json)
        .map_err(|e| format!("Failed to write registry manifest: {e}"))?;

    let client = registry_client()?;
    for asset in &package.assets {
        let relative = validate_relative_path(&asset.path, "registry asset")?;
        let bytes = match download_limited(
            &client,
            validate_https_url(&asset.url, "Plugin asset URL")?,
            asset.size.min(MAX_PLUGIN_BYTES),
            &format!("plugin asset '{}'", asset.path),
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = remove_dir_if_exists(&source);
                return Err(error);
            }
        };
        if bytes.len() as u64 != asset.size {
            let _ = remove_dir_if_exists(&source);
            return Err(format!(
                "Plugin asset '{}' size does not match the registry.",
                asset.path
            ));
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if !digest.eq_ignore_ascii_case(&asset.sha256) {
            let _ = remove_dir_if_exists(&source);
            return Err(format!(
                "Plugin asset '{}' failed its SHA-256 check.",
                asset.path
            ));
        }
        let destination = source.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create plugin asset directory: {e}"))?;
        }
        fs::write(&destination, bytes)
            .map_err(|e| format!("Failed to write plugin asset '{}': {e}", asset.path))?;
    }
    Ok(source)
}

#[tauri::command]
pub async fn get_plugin_registry(
    registry_url: Option<String>,
) -> Result<PluginRegistryIndex, String> {
    fetch_registry_index(registry_url).await
}

#[tauri::command]
pub async fn check_plugin_updates(
    registry_url: Option<String>,
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<PluginUpdateCandidate>, String> {
    let index = fetch_registry_index(registry_url).await?;
    let records = plugin_storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
    let mut updates = Vec::new();
    for record in records {
        let installed = Version::parse(&record.manifest.version).map_err(|_| {
            format!(
                "Installed plugin '{}' has an invalid version.",
                record.manifest.id
            )
        })?;
        if let Ok(package) = latest_compatible_package(&index, &record.manifest.id) {
            let available = Version::parse(&package.manifest.version)
                .map_err(|_| "Registry returned an invalid version.".to_string())?;
            if available > installed {
                updates.push(PluginUpdateCandidate {
                    plugin_id: record.manifest.id,
                    installed_version: installed.to_string(),
                    available_version: available.to_string(),
                    package: package.clone(),
                });
            }
        }
    }
    Ok(updates)
}

#[tauri::command]
pub async fn install_registry_plugin(
    plugin_id: String,
    registry_url: Option<String>,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let index = fetch_registry_index(registry_url).await?;
    let package = latest_compatible_package(&index, &plugin_id)?.clone();
    let storage = plugin_storage.inner().clone();
    let source = materialize_registry_package(&storage, &package).await?;
    let install_source = source.clone();
    let install_storage = storage.clone();
    let result = run_blocking_plugin_task(move || {
        install_bundle_from_path(&install_storage, &install_source)
    })
    .await;
    let _ = remove_dir_if_exists(&source);
    let installed = result?;
    db_manager
        .disconnect_driver_connections(&installed.manifest.id)
        .await;
    Ok(installed)
}

#[tauri::command]
pub async fn list_installed_plugins(
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<InstalledPluginRecord>, String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || sync_installed_plugins(&storage)).await
}

#[tauri::command]
pub async fn install_plugin_bundle(
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let selected_folder = FileDialog::new()
        .pick_folder()
        .ok_or_else(|| "No plugin bundle selected.".to_string())?;
    let storage = plugin_storage.inner().clone();
    let installed = run_blocking_plugin_task(move || {
        let (source_bundle_dir, _) = resolve_bundle_source(&selected_folder)?;
        install_bundle_from_path(&storage, &source_bundle_dir)
    })
    .await?;
    db_manager
        .disconnect_driver_connections(&installed.manifest.id)
        .await;
    Ok(installed)
}

#[tauri::command]
pub async fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let storage = plugin_storage.inner().clone();
    let updated = run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let index = records
            .iter()
            .position(|record| record.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let mut target = verify_installed_record(records[index].clone());
        if enabled && !target.verified {
            return Err(target
                .validation_error
                .unwrap_or_else(|| "Plugin could not be verified.".to_string()));
        }
        target.enabled = enabled;
        target.updated_at = now_unix_seconds();
        records[index] = target.clone();
        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;
        Ok(target)
    })
    .await?;
    if !updated.enabled {
        db_manager
            .disconnect_driver_connections(&updated.manifest.id)
            .await;
    }
    Ok(updated)
}

#[tauri::command]
pub async fn rollback_plugin_bundle(
    plugin_id: String,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let storage = plugin_storage.inner().clone();
    let restored = run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let index = records
            .iter()
            .position(|record| record.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let destination = PathBuf::from(&records[index].bundle_path);
        let rollback = rollback_path(&storage, &plugin_id);
        if !rollback.is_dir() {
            return Err(format!("Plugin '{plugin_id}' has no rollback version."));
        }
        let validated = validate_bundle(&rollback)?;
        if validated.manifest.id != plugin_id {
            return Err("Rollback bundle id does not match the installed plugin.".to_string());
        }

        let swap = storage
            .staging_dir()
            .join(format!("rollback-{plugin_id}-{}", Uuid::new_v4()));
        fs::rename(&destination, &swap)
            .map_err(|e| format!("Failed to stage the current plugin version: {e}"))?;
        if let Err(error) = fs::rename(&rollback, &destination) {
            let _ = fs::rename(&swap, &destination);
            return Err(format!("Failed to activate the rollback version: {error}"));
        }
        if let Err(error) = fs::rename(&swap, &rollback) {
            let _ = fs::rename(&destination, &swap);
            let _ = fs::rename(&rollback, &destination);
            let _ = fs::rename(&swap, &rollback);
            return Err(format!(
                "Failed to preserve the replaced plugin version: {error}"
            ));
        }

        let current_version = records[index].manifest.version.clone();
        let now = now_unix_seconds();
        records[index] = InstalledPluginRecord {
            manifest: validated.manifest,
            bundle_path: destination.to_string_lossy().to_string(),
            enabled: records[index].enabled,
            installed_at: records[index].installed_at,
            updated_at: now,
            verified: true,
            computed_integrity: Some(validated.digest),
            validation_error: None,
            rollback_available: true,
            previous_version: Some(current_version),
        };
        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save rollback state: {e}"))?;
        Ok(records[index].clone())
    })
    .await?;
    db_manager
        .disconnect_driver_connections(&restored.manifest.id)
        .await;
    Ok(restored)
}

#[tauri::command]
pub async fn uninstall_plugin_bundle(
    plugin_id: String,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<(), String> {
    let storage = plugin_storage.inner().clone();
    let removed_plugin_id = plugin_id.clone();
    run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let existing = records
            .iter()
            .find(|record| record.manifest.id == plugin_id)
            .cloned()
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        remove_dir_if_exists(Path::new(&existing.bundle_path))?;
        remove_dir_if_exists(&rollback_path(&storage, &plugin_id))?;
        records.retain(|record| record.manifest.id != plugin_id);
        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;
        Ok(())
    })
    .await?;
    db_manager
        .disconnect_driver_connections(&removed_plugin_id)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn reload_installed_plugins(
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<InstalledPluginRecord>, String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || sync_installed_plugins(&storage)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::plugin_storage::{
        PluginCompatibility, PluginContributions, PluginDriverContribution, PluginIntegrity,
    };

    fn manifest() -> PluginManifest {
        PluginManifest {
            api_version: 1,
            id: "sample-format".to_string(),
            name: "Sample format".to_string(),
            version: "1.2.3".to_string(),
            kind: "export".to_string(),
            description: None,
            author: None,
            entry: Some("entry.wasm".to_string()),
            capabilities: vec!["export".to_string()],
            permissions: vec![],
            compatibility: PluginCompatibility::default(),
            integrity: Some(PluginIntegrity {
                algorithm: "sha256".to_string(),
                digest: "0".repeat(64),
            }),
            update_url: None,
            contributes: PluginContributions::default(),
        }
    }

    #[test]
    fn rejects_unknown_capabilities() {
        let root = std::env::temp_dir().join(format!("tabler-plugin-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("entry.wasm"), b"wasm").unwrap();
        let mut value = manifest();
        value.capabilities.push("host.shell".to_string());
        let error = validate_manifest(&value, &root).unwrap_err();
        assert!(error.contains("Unknown plugin capability"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_entry_path_traversal() {
        let root = std::env::temp_dir().join(format!("tabler-plugin-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut value = manifest();
        value.entry = Some("../outside.wasm".to_string());
        let error = validate_manifest(&value, &root).unwrap_err();
        assert!(error.contains("cannot escape"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn digest_changes_when_bundle_content_changes() {
        let root = std::env::temp_dir().join(format!("tabler-plugin-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("entry.wasm"), b"first").unwrap();
        let value = manifest();
        let first = compute_bundle_digest(&root, &value).unwrap();
        fs::write(root.join("entry.wasm"), b"second").unwrap();
        let second = compute_bundle_digest(&root, &value).unwrap();
        assert_ne!(first, second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_portable_formats_bundle_is_valid() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("portable-formats");
        let validated = validate_bundle(&bundle).unwrap();
        assert_eq!(validated.manifest.id, "portable-formats");
        assert_eq!(validated.manifest.contributes.formats.len(), 3);
    }

    #[test]
    fn official_opensearch_driver_bundle_is_valid_and_permission_bounded() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("opensearch-driver");
        let validated = validate_bundle(&bundle).unwrap();
        let driver = &validated.manifest.contributes.drivers[0];
        assert_eq!(driver.protocol, "opensearch");
        assert_eq!(driver.runtime, "declarative-http-v1");

        let mut missing_permission = validated.manifest;
        missing_permission
            .permissions
            .retain(|permission| permission != "network.fetch");
        assert!(validate_contributions(&missing_permission)
            .unwrap_err()
            .contains("network.fetch"));
    }

    #[test]
    fn active_driver_resolution_rechecks_integrity_and_managed_location() {
        let root = std::env::temp_dir().join(format!("tabler-driver-runtime-{}", Uuid::new_v4()));
        let storage = PluginStorage::from_data_dir(root.clone()).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("opensearch-driver");
        let destination = storage.bundles_dir().join("opensearch-driver.tableplugin");
        copy_dir_recursive(&source, &destination).unwrap();
        let validated = validate_bundle(&destination).unwrap();
        storage
            .save_plugins(&[InstalledPluginRecord {
                manifest: validated.manifest,
                bundle_path: destination.to_string_lossy().to_string(),
                enabled: true,
                installed_at: now_unix_seconds(),
                updated_at: now_unix_seconds(),
                verified: true,
                computed_integrity: Some(validated.digest),
                validation_error: None,
                rollback_available: false,
                previous_version: None,
            }])
            .unwrap();

        let active =
            resolve_active_plugin_driver(&storage, "opensearch-driver", "opensearch").unwrap();
        assert_eq!(active.contribution.runtime, "declarative-http-v1");

        let manifest_path = destination.join("plugin.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["description"] = serde_json::Value::String("tampered".to_string());
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(resolve_active_plugin_driver(&storage, "opensearch-driver", "opensearch").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unrecognized_declarative_driver_protocols() {
        let mut value = manifest();
        value.kind = "adapter".to_string();
        value.capabilities = vec!["database".to_string()];
        value.permissions = vec![
            "connection.metadata".to_string(),
            "query.read".to_string(),
            "query.execute".to_string(),
            "network.fetch".to_string(),
        ];
        value.contributes.drivers = vec![PluginDriverContribution {
            id: "unsafe-proxy".to_string(),
            label: "Unsafe proxy".to_string(),
            protocol: "arbitrary-http".to_string(),
            runtime: "declarative-http-v1".to_string(),
            status: "stable".to_string(),
        }];
        assert!(validate_contributions(&value)
            .unwrap_err()
            .contains("unsupported"));
    }

    #[test]
    fn generated_registry_matches_the_runtime_contract() {
        let registry_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugin-registry.json");
        let raw = fs::read(registry_path).unwrap();
        let registry: PluginRegistryIndex = serde_json::from_slice(&raw).unwrap();
        validate_registry(&registry).unwrap();
        assert_eq!(registry.schema_version, 1);
        assert_eq!(registry.packages.len(), 2);
    }

    #[test]
    fn registry_urls_must_be_https_without_credentials() {
        assert!(validate_https_url("https://example.com/plugins.json", "Registry").is_ok());
        assert!(validate_https_url("http://example.com/plugins.json", "Registry").is_err());
        assert!(
            validate_https_url("https://user:secret@example.com/plugins.json", "Registry").is_err()
        );
    }
}
