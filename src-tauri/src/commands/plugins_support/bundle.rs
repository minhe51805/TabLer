//! Plugin bundle handling: locating the bundle root/manifest, enumerating the
//! files it declares, and computing/validating the content digest.

use crate::commands::plugins::{ValidatedBundle, MAX_PLUGIN_BYTES, MAX_PLUGIN_FILES};
use crate::storage::plugin_storage::PluginManifest;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::manifest::{read_plugin_manifest, validate_manifest};

pub(crate) fn resolve_bundle_source(root: &Path) -> Result<(PathBuf, PathBuf), String> {
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

pub(super) fn collect_bundle_files(
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

pub(crate) fn compute_bundle_digest(
    bundle_dir: &Path,
    manifest: &PluginManifest,
) -> Result<String, String> {
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

pub(crate) fn validate_bundle(bundle_dir: &Path) -> Result<ValidatedBundle, String> {
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
