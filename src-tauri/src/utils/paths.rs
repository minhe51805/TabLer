use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

pub fn resolve_data_dir() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TABLER_DATA_DIR") {
        let path = PathBuf::from(path);
        fs::create_dir_all(&path).with_context(|| {
            format!("Failed to create debug data directory '{}'", path.display())
        })?;
        return Ok(path);
    }

    let base_dir = dirs::data_dir()
        .context("Cannot find user data directory")?
        .join("TableR");

    fs::create_dir_all(&base_dir)?;

    let override_file = base_dir.join(".sync_override");
    if override_file.exists() {
        if let Ok(override_path_str) = fs::read_to_string(&override_file) {
            let override_path = PathBuf::from(override_path_str.trim());
            if override_path.exists() && override_path.is_dir() {
                return Ok(override_path);
            }
            // The configured sync folder is gone (drive unplugged, share
            // unmounted, folder deleted). Falling back silently makes the app
            // open with an empty workspace — warn so the user knows why their
            // data "disappeared" and where to look.
            crate::storage_notices::push_storage_notice(crate::storage_notices::StorageNotice {
                id: "sync-override-unavailable".to_string(),
                kind: "warning".to_string(),
                title: "Sync folder unavailable".to_string(),
                message: format!(
                    "The sync folder '{}' configured in .sync_override is not reachable, so \
                         TableR is using the local data directory '{}' instead. Your synced \
                         connections and workspace data will reappear once the folder is \
                         available again.",
                    override_path.display(),
                    base_dir.display()
                ),
            });
        }
    }

    Ok(base_dir)
}
