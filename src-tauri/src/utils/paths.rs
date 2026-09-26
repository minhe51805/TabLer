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

    resolve_base_data_dir(base_dir)
}

/// Resolves the persistence root once the platform base directory is known:
/// honors a `.sync_override` pointer file inside `base_dir`, falling back to
/// `base_dir` (with a user-visible notice) when the target is unreachable.
fn resolve_base_data_dir(base_dir: PathBuf) -> Result<PathBuf> {
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

/// Shared scaffolding for tests that need a temporary data directory. Only
/// compiled into the test build; the env override itself is debug-only, which
/// every `cargo test` binary satisfies.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::{LazyLock, Mutex};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    /// Runs `f` with `TABLER_DATA_DIR` pointed at `dir`, serialized against
    /// every other env-dependent test in the crate and restoring the previous
    /// value even when the body panics.
    pub(crate) fn run_with_data_dir_env<F: FnOnce()>(dir: &std::path::Path, f: F) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let previous = std::env::var_os("TABLER_DATA_DIR");
        std::env::set_var("TABLER_DATA_DIR", dir);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        match previous {
            Some(value) => std::env::set_var("TABLER_DATA_DIR", value),
            None => std::env::remove_var("TABLER_DATA_DIR"),
        }
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }

    /// `TABLER_DATA_DIR` is only honored in debug builds — `cargo test`
    /// always builds with `debug_assertions`, so this holds for tests.
    pub(crate) fn fresh_temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_base_data_dir, test_support};

    #[test]
    fn env_override_selects_the_data_dir_in_debug_builds() {
        let dir = test_support::fresh_temp_dir("tabler-paths-env");
        test_support::run_with_data_dir_env(&dir, || {
            assert_eq!(super::resolve_data_dir().unwrap(), dir);
        });
    }

    #[test]
    fn sync_override_redirects_to_an_existing_directory() {
        let base = test_support::fresh_temp_dir("tabler-paths-base");
        let sync = test_support::fresh_temp_dir("tabler-paths-sync");
        std::fs::write(
            base.join(".sync_override"),
            format!(" {} \n", sync.display()),
        )
        .unwrap();
        assert_eq!(resolve_base_data_dir(base).unwrap(), sync);
    }

    #[test]
    fn unreachable_sync_override_falls_back_with_a_notice() {
        let base = test_support::fresh_temp_dir("tabler-paths-base");
        let gone = test_support::fresh_temp_dir("tabler-paths-gone").join("missing");
        std::fs::write(base.join(".sync_override"), gone.display().to_string()).unwrap();

        let resolved = resolve_base_data_dir(base.clone()).unwrap();
        assert_eq!(resolved, base, "missing sync target must keep the base dir");
        assert!(
            crate::storage_notices::test_support::notice_was_raised("sync-override-unavailable"),
            "fallback must raise the 'Sync folder unavailable' notice"
        );
    }

    #[test]
    fn override_pointing_at_a_file_is_not_a_sync_dir() {
        let base = test_support::fresh_temp_dir("tabler-paths-base");
        let not_a_dir = test_support::fresh_temp_dir("tabler-paths-file").join("file.txt");
        std::fs::write(&not_a_dir, "x").unwrap();
        std::fs::write(base.join(".sync_override"), not_a_dir.display().to_string()).unwrap();
        assert_eq!(
            resolve_base_data_dir(base.clone()).unwrap(),
            base,
            "a file path must not be treated as a sync folder"
        );
    }
}
