//! Remote plugin registry client: HTTPS fetch with byte caps, a URL-scoped
//! on-disk cache with offline fallback, index validation, and package
//! materialization into an installable bundle.

use crate::commands::plugins::{
    PluginRegistryIndex, PluginRegistryPackage, DEFAULT_PLUGIN_REGISTRY_URL, MAX_PLUGIN_BYTES,
    MAX_PLUGIN_FILES, MAX_REGISTRY_BYTES,
};
use crate::storage::file_storage::write_json_atomically;
use crate::storage::plugin_storage::PluginStorage;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use semver::Version;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::manifest::{validate_compatibility, validate_manifest_metadata, validate_relative_path};
use super::{remove_dir_if_exists, slugify_plugin_id};

pub(crate) fn validate_https_url(value: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| format!("{label} is not a valid URL."))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(format!("{label} must use HTTPS."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} cannot contain embedded credentials."));
    }
    Ok(url)
}

pub(super) async fn download_limited(
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

pub(super) fn registry_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("TableR/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to create plugin registry client: {e}"))
}

pub(crate) fn validate_registry(index: &PluginRegistryIndex) -> Result<(), String> {
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CachedPluginRegistry {
    /// The registry URL this copy came from — a cached index is only served
    /// back for the exact same URL so a custom registry never leaks entries
    /// into the default one.
    url: String,
    body: PluginRegistryIndex,
}

fn parse_registry_bytes(bytes: &[u8]) -> Result<PluginRegistryIndex, String> {
    let index = serde_json::from_slice::<PluginRegistryIndex>(bytes)
        .map_err(|e| format!("Plugin registry JSON is invalid: {e}"))?;
    validate_registry(&index)?;
    Ok(index)
}

pub(super) fn write_registry_cache(path: &std::path::Path, url: &str, index: &PluginRegistryIndex) {
    let cache = CachedPluginRegistry {
        url: url.to_string(),
        body: index.clone(),
    };
    match serde_json::to_string_pretty(&cache) {
        Ok(json) => {
            if let Err(error) = write_json_atomically(path, &json) {
                log::warn!("Failed to cache the plugin registry: {error}");
            }
        }
        Err(error) => log::warn!("Failed to serialize the plugin registry cache: {error}"),
    }
}

pub(super) fn read_registry_cache(
    path: &std::path::Path,
    url: &str,
) -> Option<PluginRegistryIndex> {
    let raw = fs::read(path).ok()?;
    let cache: CachedPluginRegistry = serde_json::from_slice(&raw).ok()?;
    if cache.url != url {
        return None;
    }
    parse_registry_bytes(&serde_json::to_vec(&cache.body).ok()?).ok()
}

pub(crate) async fn fetch_registry_index(
    registry_url: Option<String>,
    cache_path: Option<&std::path::Path>,
) -> Result<PluginRegistryIndex, String> {
    let raw_url = registry_url
        .as_deref()
        .unwrap_or(DEFAULT_PLUGIN_REGISTRY_URL);
    let url = validate_https_url(raw_url, "Plugin registry URL")?;
    let client = registry_client()?;
    let fetch_result = download_limited(&client, url, MAX_REGISTRY_BYTES, "plugin registry")
        .await
        .and_then(|bytes| parse_registry_bytes(&bytes));
    match fetch_result {
        Ok(index) => {
            // Persist the last good copy so the marketplace survives outages.
            if let Some(path) = cache_path {
                write_registry_cache(path, raw_url, &index);
            }
            Ok(index)
        }
        Err(fetch_error) => {
            // Offline fallback: a GitHub outage or a renamed repository must
            // not brick plugin browsing and update checks — degrade to the
            // stale-but-validated cached catalog for this exact URL.
            if let Some(path) = cache_path {
                if let Some(index) = read_registry_cache(path, raw_url) {
                    log::warn!(
                        "Plugin registry fetch failed ({fetch_error}); using the cached copy from {}",
                        path.display()
                    );
                    return Ok(index);
                }
            }
            Err(fetch_error)
        }
    }
}

pub(crate) fn latest_compatible_package<'a>(
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

pub(crate) async fn materialize_registry_package(
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
