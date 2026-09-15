//! Registry cache + offline-fallback behavior.

use std::fs;
use std::path::Path;
use uuid::Uuid;

use crate::commands::plugins::PluginRegistryIndex;

use super::registry::{fetch_registry_index, read_registry_cache, write_registry_cache};

#[test]
fn registry_cache_ignores_entries_from_a_different_url() {
    let index = PluginRegistryIndex {
        schema_version: 1,
        generated_at: "2026-01-01T00:00:00Z".to_string(),
        packages: Vec::new(),
    };
    let cache_path =
        std::env::temp_dir().join(format!("tabler-registry-cache-{}.json", Uuid::new_v4()));
    write_registry_cache(
        &cache_path,
        "https://registry-a.example.com/index.json",
        &index,
    );
    // Same cache file, different registry URL: the entry must not be
    // served — custom registries never leak into each other.
    assert!(
        read_registry_cache(&cache_path, "https://registry-b.example.com/index.json").is_none()
    );
    assert!(
        read_registry_cache(&cache_path, "https://registry-a.example.com/index.json").is_some()
    );
    let _ = fs::remove_file(&cache_path);
}

#[tokio::test]
async fn registry_fetch_falls_back_to_the_cached_copy_when_offline() {
    // Reuse the repository's real registry so the cached body passes
    // validate_registry without hand-rolling a fixture.
    let registry_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugin-registry.json");
    let index: PluginRegistryIndex =
        serde_json::from_slice(&fs::read(registry_path).unwrap()).unwrap();
    let url = "https://registry-cache-test.invalid/plugin-registry.json";
    let cache_path =
        std::env::temp_dir().join(format!("tabler-registry-cache-{}.json", Uuid::new_v4()));
    write_registry_cache(&cache_path, url, &index);

    // The .invalid host fails DNS resolution; the cached copy must step in.
    let result = fetch_registry_index(Some(url.to_string()), Some(&cache_path)).await;

    let _ = fs::remove_file(&cache_path);
    let served = result.expect("offline fallback must serve the cached registry");
    assert_eq!(served.packages.len(), index.packages.len());
}
