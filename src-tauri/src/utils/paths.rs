use std::fs;
use std::path::PathBuf;
use anyhow::{Context, Result};

pub fn resolve_data_dir() -> Result<PathBuf> {
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
        }
    }

    Ok(base_dir)
}
