//! Plugin manifest parsing and validation: metadata, contribution points,
//! engine/API compatibility, and relative-path safety checks.

use crate::commands::plugins::{
    ALLOWED_CAPABILITIES, ALLOWED_KINDS, ALLOWED_PERMISSIONS, PLUGIN_API_VERSION,
};
use crate::storage::plugin_storage::PluginManifest;
use semver::Version;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::slugify_plugin_id;

pub(super) fn read_plugin_manifest(manifest_path: &Path) -> Result<PluginManifest, String> {
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

pub(super) fn normalize_declarations(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

pub(super) fn validate_relative_path(value: &str, label: &str) -> Result<PathBuf, String> {
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

pub(super) fn validate_manifest_metadata(manifest: &PluginManifest) -> Result<(), String> {
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

pub(crate) fn validate_manifest(
    manifest: &PluginManifest,
    bundle_dir: &Path,
) -> Result<(), String> {
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

pub(crate) fn validate_contributions(manifest: &PluginManifest) -> Result<(), String> {
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
                if !crate::database::capabilities::is_declarative_http_protocol(&driver.protocol) {
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
            ("driver-sidecar-v1", "stable") | ("driver-sidecar-v1", "experimental") => {
                // Native engines delivered as an out-of-process sidecar. The
                // protocol must be a `PluginNative` engine, sourced from the same
                // matrix as the HTTP allow-list so it cannot drift.
                if !crate::database::capabilities::is_plugin_native_protocol(&driver.protocol) {
                    return Err(format!(
                        "Driver '{}' uses a protocol unsupported by driver-sidecar-v1.",
                        driver.id
                    ));
                }
                for permission in ["connection.metadata", "query.read", "query.execute"] {
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

pub(super) fn validate_compatibility(manifest: &PluginManifest) -> Result<(), String> {
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

pub(super) fn validate_compatibility_metadata(manifest: &PluginManifest) -> Result<(), String> {
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
