//! Workspace bundle export/import for team sharing.
//!
//! A `.tabler-bundle` file is a single plain-JSON document bundling the
//! shareable parts of a workspace: saved connections, SQL favorites, saved
//! schedules, AI provider preferences, and UI preferences. UI prefs are the
//! webview's `tabler.*` localStorage keys — the frontend snapshots them into
//! the bundle on export and writes the missing ones back on import, since
//! localStorage is unreachable from Rust. Secrets never leave the machine —
//! connection passwords/SSH material stay in the OS keyring and AI API keys
//! stay in theirs; the bundle only carries `hasPassword`/`hasApiKey` flags so
//! the importer knows which credentials to re-enter.
//!
//! `import_workspace_bundle` is a two-phase command: called without a
//! `selection` it returns a preview (every item plus an `exists` flag computed
//! against current storage); called with a `selection` it persists the chosen
//! indices per section and reports per-section counts.

use crate::commands::connection_export::{is_same_connection, ExportableConnection};
use crate::database::ai_models::AIProviderConfig;
use crate::database::models::ConnectionConfig;
use crate::storage::ai_storage::AIStorage;
use crate::storage::connection_storage::ConnectionStorage;
use crate::storage::schedule_storage::{QuerySchedule, ScheduleStorage};
use crate::storage::sql_favorites::{SqlFavorite, SqlFavoritesStorage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::State;

const BUNDLE_FORMAT: &str = "tabler.workspace-bundle";
const BUNDLE_VERSION: u8 = 1;

/// A connection entry in the bundle: the full shareable profile plus the
/// original id (so favorites/schedules keep pointing at it) and a flag telling
/// the importer that credentials must be re-entered.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleConnection {
    pub id: String,
    pub has_password: bool,
    #[serde(flatten)]
    pub connection: ExportableConnection,
}

/// An AI provider entry: the full provider config (which never contains the
/// API key itself) plus a flag for the keyring-stored key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleAiProvider {
    pub has_api_key: bool,
    #[serde(flatten)]
    pub config: AIProviderConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundle {
    pub format: String,
    pub version: u8,
    pub exported_at: String,
    #[serde(default)]
    pub connections: Vec<BundleConnection>,
    #[serde(default)]
    pub sql_favorites: Vec<SqlFavorite>,
    #[serde(default)]
    pub schedules: Vec<QuerySchedule>,
    #[serde(default)]
    pub ai_providers: Vec<BundleAiProvider>,
    /// `tabler.*` localStorage snapshot supplied by the exporting frontend.
    /// Absent in bundles written before this section existed.
    #[serde(default)]
    pub ui_prefs: BTreeMap<String, String>,
}

// ─── Preview / selection / result types ─────────────────────────────────────

/// One checklist row in the import preview. `exists` means the item is already
/// present locally (same id, or the section's identity rule) and importing it
/// would be a no-op.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleItemPreview {
    pub index: usize,
    pub id: String,
    pub name: String,
    pub detail: String,
    pub exists: bool,
    /// Connections only: credentials were stripped on export and must be
    /// re-entered after import.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub needs_password: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundlePreview {
    pub exported_at: String,
    pub connections: Vec<BundleItemPreview>,
    pub sql_favorites: Vec<BundleItemPreview>,
    pub schedules: Vec<BundleItemPreview>,
    pub ai_providers: Vec<BundleItemPreview>,
    /// One row per bundled localStorage key; `exists` means the key is already
    /// present locally (the importer passes its current key list).
    pub ui_prefs: Vec<BundleItemPreview>,
}

/// Per-section selection for the import phase. `None` for a section means
/// "import nothing from it"; `Some(indices)` imports exactly those bundle
/// indices (an empty vec imports none).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundleSelection {
    #[serde(default)]
    pub connections: Option<Vec<usize>>,
    #[serde(default)]
    pub sql_favorites: Option<Vec<usize>>,
    #[serde(default)]
    pub schedules: Option<Vec<usize>>,
    #[serde(default)]
    pub ai_providers: Option<Vec<usize>>,
    /// Indices into `bundle.ui_prefs` (sorted by key). The frontend offers a
    /// single "UI preferences" checkbox that selects every index.
    #[serde(default)]
    pub ui_prefs: Option<Vec<usize>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundleCounts {
    pub connections: usize,
    pub sql_favorites: usize,
    pub schedules: usize,
    pub ai_providers: usize,
    /// localStorage keys returned for the frontend to write (missing only).
    pub ui_prefs: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundleImportResult {
    pub preview: WorkspaceBundlePreview,
    /// Present only when a `selection` was supplied (real import).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<WorkspaceBundleCounts>,
    /// Selected UI-pref entries that are missing locally — the frontend writes
    /// them to localStorage. Present only when `selection.ui_prefs` was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_prefs: Option<BTreeMap<String, String>>,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn connection_detail(connection: &ExportableConnection) -> String {
    let endpoint = connection
        .host
        .as_deref()
        .or(connection.file_path.as_deref())
        .unwrap_or("");
    match connection.port {
        Some(port) if !endpoint.is_empty() => format!("{endpoint}:{port}"),
        _ => endpoint.to_string(),
    }
}

fn favorite_identity(favorite: &SqlFavorite) -> (String, String) {
    (favorite.name.clone(), favorite.sql.clone())
}

fn schedule_identity(schedule: &QuerySchedule) -> (String, String) {
    (schedule.name.clone(), schedule.sql.clone())
}

fn load_bundle(path: &str) -> Result<WorkspaceBundle, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("Failed to read bundle file: {error}"))?;
    // Check the format marker before full deserialization so a foreign JSON
    // file gets a clear "not a bundle" error instead of a field-level parse
    // failure.
    let header: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse workspace bundle: {error}"))?;
    if header.get("format").and_then(|v| v.as_str()) != Some(BUNDLE_FORMAT) {
        return Err("Not a TableR workspace bundle file.".to_string());
    }
    let bundle: WorkspaceBundle = serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse workspace bundle: {error}"))?;
    if bundle.version > BUNDLE_VERSION {
        return Err(format!(
            "Bundle version {} is newer than this app supports ({}).",
            bundle.version, BUNDLE_VERSION
        ));
    }
    Ok(bundle)
}

fn build_preview(
    bundle: &WorkspaceBundle,
    existing_connections: &[ConnectionConfig],
    existing_favorites: &[SqlFavorite],
    existing_schedules: &[QuerySchedule],
    existing_provider_ids: &HashSet<String>,
    existing_ui_pref_keys: &HashSet<String>,
) -> WorkspaceBundlePreview {
    let connections = bundle
        .connections
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let candidate = entry.connection.to_connection_config(None);
            let exists = existing_connections
                .iter()
                .any(|saved| saved.id == entry.id || is_same_connection(saved, &candidate));
            BundleItemPreview {
                index,
                id: entry.id.clone(),
                name: entry.connection.name.clone(),
                detail: connection_detail(&entry.connection),
                exists,
                needs_password: entry.has_password,
            }
        })
        .collect();

    let favorite_keys: HashSet<(String, String)> =
        existing_favorites.iter().map(favorite_identity).collect();
    let favorite_ids: HashSet<&str> = existing_favorites
        .iter()
        .map(|favorite| favorite.id.as_str())
        .collect();
    let sql_favorites = bundle
        .sql_favorites
        .iter()
        .enumerate()
        .map(|(index, favorite)| BundleItemPreview {
            index,
            id: favorite.id.clone(),
            name: favorite.name.clone(),
            detail: favorite
                .description
                .clone()
                .unwrap_or_else(|| favorite.sql.chars().take(60).collect()),
            exists: favorite_ids.contains(favorite.id.as_str())
                || favorite_keys.contains(&favorite_identity(favorite)),
            needs_password: false,
        })
        .collect();

    let schedule_keys: HashSet<(String, String)> =
        existing_schedules.iter().map(schedule_identity).collect();
    let schedule_ids: HashSet<&str> = existing_schedules
        .iter()
        .map(|schedule| schedule.id.as_str())
        .collect();
    let schedules = bundle
        .schedules
        .iter()
        .enumerate()
        .map(|(index, schedule)| BundleItemPreview {
            index,
            id: schedule.id.clone(),
            name: schedule.name.clone(),
            detail: format!("every {}s", schedule.interval_seconds),
            exists: schedule_ids.contains(schedule.id.as_str())
                || schedule_keys.contains(&schedule_identity(schedule)),
            needs_password: false,
        })
        .collect();

    let ai_providers = bundle
        .ai_providers
        .iter()
        .enumerate()
        .map(|(index, provider)| BundleItemPreview {
            index,
            id: provider.config.id.clone(),
            name: provider.config.name.clone(),
            detail: provider.config.model.clone(),
            exists: existing_provider_ids.contains(&provider.config.id),
            needs_password: provider.has_api_key,
        })
        .collect();

    // One row per bundled localStorage key, sorted by key (BTreeMap order) so
    // selection indices are stable across preview and import calls.
    let ui_prefs = bundle
        .ui_prefs
        .iter()
        .enumerate()
        .map(|(index, (key, value))| BundleItemPreview {
            index,
            id: key.clone(),
            name: key.clone(),
            detail: value.chars().take(60).collect(),
            exists: existing_ui_pref_keys.contains(key),
            needs_password: false,
        })
        .collect();

    WorkspaceBundlePreview {
        exported_at: bundle.exported_at.clone(),
        connections,
        sql_favorites,
        schedules,
        ai_providers,
        ui_prefs,
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Writes the whole shareable workspace to a single `.tabler-bundle` JSON file
/// at `path`. Secrets are stripped: connections keep a `hasPassword` flag and
/// AI providers a `hasApiKey` flag, but keyring material never leaves the
/// machine.
#[tauri::command]
pub fn export_workspace_bundle(
    path: String,
    conn_storage: State<'_, ConnectionStorage>,
    ai_storage: State<'_, AIStorage>,
    ui_prefs: Option<BTreeMap<String, String>>,
) -> Result<String, String> {
    export_workspace_bundle_core(
        &path,
        &conn_storage,
        &SqlFavoritesStorage::new()?,
        &ScheduleStorage::new()?,
        &ai_storage,
        ui_prefs.unwrap_or_default(),
    )
}

fn export_workspace_bundle_core(
    path: &str,
    conn_storage: &ConnectionStorage,
    favorites_storage: &SqlFavoritesStorage,
    schedule_storage: &ScheduleStorage,
    ai_storage: &AIStorage,
    ui_prefs: BTreeMap<String, String>,
) -> Result<String, String> {
    let connections = conn_storage
        .load_connections()
        .map_err(|error| format!("Failed to load saved connections: {error}"))?
        .into_iter()
        .map(|config| {
            // `load_connections` returns redacted configs; ask the keyring
            // whether secrets exist so the flag is honest.
            let has_password = conn_storage
                .load_connection_by_id(&config.id)
                .map(|full| {
                    let ssh = full.ssh_config.as_ref();
                    full.password.is_some()
                        || ssh.and_then(|s| s.password.clone()).is_some()
                        || ssh.and_then(|s| s.private_key.clone()).is_some()
                        || ssh.and_then(|s| s.passphrase.clone()).is_some()
                })
                .unwrap_or(false);
            BundleConnection {
                id: config.id.clone(),
                has_password,
                connection: ExportableConnection::from(&config),
            }
        })
        .collect();

    let sql_favorites = favorites_storage.get_all();
    let schedules = schedule_storage.get_all();

    let (providers, key_status) = ai_storage
        .load_providers()
        .map_err(|error| format!("Failed to load AI providers: {error}"))?;
    let ai_providers = providers
        .into_iter()
        .map(|config| {
            let has_api_key = key_status.get(&config.id).copied().unwrap_or(false);
            BundleAiProvider {
                has_api_key,
                config,
            }
        })
        .collect();

    let bundle = WorkspaceBundle {
        format: BUNDLE_FORMAT.to_string(),
        version: BUNDLE_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        connections,
        sql_favorites,
        schedules,
        ai_providers,
        ui_prefs,
    };

    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|error| format!("Failed to serialize workspace bundle: {error}"))?;
    std::fs::write(path, &json).map_err(|error| format!("Failed to write bundle file: {error}"))?;
    Ok(path.to_string())
}

/// Two-phase bundle import.
///
/// Without `selection`: pure preview — parses the bundle, flags every item
/// that already exists locally, saves nothing.
///
/// With `selection`: persists the chosen indices per section. Connections keep
/// their bundle id (so favorites/schedules still resolve); when a connection
/// is skipped because an equivalent one already exists under a different id,
/// its id is remapped so dependent favorites/schedules point at the local row.
/// Returns the preview plus per-section imported counts.
/// `ui_pref_keys` carries the importer's current `tabler.*` localStorage keys —
/// used to flag existing prefs in the preview and to return only missing entries.
#[tauri::command]
pub fn import_workspace_bundle(
    path: String,
    selection: Option<WorkspaceBundleSelection>,
    conn_storage: State<'_, ConnectionStorage>,
    ai_storage: State<'_, AIStorage>,
    ui_pref_keys: Option<Vec<String>>,
) -> Result<WorkspaceBundleImportResult, String> {
    import_workspace_bundle_core(
        &path,
        selection,
        &conn_storage,
        &mut SqlFavoritesStorage::new()?,
        &mut ScheduleStorage::new()?,
        &ai_storage,
        ui_pref_keys.unwrap_or_default().into_iter().collect(),
    )
}

fn import_workspace_bundle_core(
    path: &str,
    selection: Option<WorkspaceBundleSelection>,
    conn_storage: &ConnectionStorage,
    favorites_storage: &mut SqlFavoritesStorage,
    schedule_storage: &mut ScheduleStorage,
    ai_storage: &AIStorage,
    existing_ui_pref_keys: HashSet<String>,
) -> Result<WorkspaceBundleImportResult, String> {
    let bundle = load_bundle(path)?;

    let existing_connections = conn_storage
        .load_connections()
        .map_err(|error| format!("Failed to load saved connections: {error}"))?;
    let existing_favorites = favorites_storage.get_all();
    let existing_schedules = schedule_storage.get_all();
    let (existing_providers, _) = ai_storage
        .load_providers()
        .map_err(|error| format!("Failed to load AI providers: {error}"))?;
    let existing_provider_ids: HashSet<String> = existing_providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect();

    let preview = build_preview(
        &bundle,
        &existing_connections,
        &existing_favorites,
        &existing_schedules,
        &existing_provider_ids,
        &existing_ui_pref_keys,
    );

    let Some(selection) = selection else {
        return Ok(WorkspaceBundleImportResult {
            preview,
            counts: None,
            ui_prefs: None,
        });
    };

    let mut counts = WorkspaceBundleCounts {
        connections: 0,
        sql_favorites: 0,
        schedules: 0,
        ai_providers: 0,
        ui_prefs: 0,
    };

    // Connections first: they produce the id remap the other sections need.
    let mut connection_id_map: HashMap<String, String> = HashMap::new();
    if let Some(indices) = &selection.connections {
        for &index in indices {
            let Some(entry) = bundle.connections.get(index) else {
                continue;
            };
            let mut config = entry.connection.to_connection_config(None);
            config.id = entry.id.clone();
            if let Some(existing) = existing_connections
                .iter()
                .find(|saved| saved.id == entry.id || is_same_connection(saved, &config))
            {
                connection_id_map.insert(entry.id.clone(), existing.id.clone());
                continue;
            }
            conn_storage
                .save_connection(&config)
                .map_err(|error| format!("Failed to save imported connection: {error}"))?;
            connection_id_map.insert(entry.id.clone(), config.id.clone());
            counts.connections += 1;
        }
    }

    let remap_connection_id = |connection_id: &mut Option<String>| {
        if let Some(id) = connection_id.as_ref() {
            if let Some(mapped) = connection_id_map.get(id) {
                *connection_id = Some(mapped.clone());
            }
        }
    };

    if let Some(indices) = &selection.sql_favorites {
        let storage = &mut *favorites_storage;
        let existing_keys: HashSet<(String, String)> =
            existing_favorites.iter().map(favorite_identity).collect();
        let existing_ids: HashSet<&str> = existing_favorites
            .iter()
            .map(|favorite| favorite.id.as_str())
            .collect();
        for &index in indices {
            let Some(favorite) = bundle.sql_favorites.get(index) else {
                continue;
            };
            if existing_ids.contains(favorite.id.as_str())
                || existing_keys.contains(&favorite_identity(favorite))
            {
                continue;
            }
            let mut favorite = favorite.clone();
            remap_connection_id(&mut favorite.connection_id);
            storage.save(favorite)?;
            counts.sql_favorites += 1;
        }
    }

    if let Some(indices) = &selection.schedules {
        let storage = &mut *schedule_storage;
        let existing_keys: HashSet<(String, String)> =
            existing_schedules.iter().map(schedule_identity).collect();
        let existing_ids: HashSet<&str> = existing_schedules
            .iter()
            .map(|schedule| schedule.id.as_str())
            .collect();
        for &index in indices {
            let Some(schedule) = bundle.schedules.get(index) else {
                continue;
            };
            if existing_ids.contains(schedule.id.as_str())
                || existing_keys.contains(&schedule_identity(schedule))
            {
                continue;
            }
            let mut schedule = schedule.clone();
            remap_connection_id(&mut schedule.connection_id);
            storage.save(schedule)?;
            counts.schedules += 1;
        }
    }

    if let Some(indices) = &selection.ai_providers {
        let mut providers = existing_providers.clone();
        for &index in indices {
            let Some(entry) = bundle.ai_providers.get(index) else {
                continue;
            };
            if providers
                .iter()
                .any(|provider| provider.id == entry.config.id)
            {
                continue;
            }
            providers.push(entry.config.clone());
            counts.ai_providers += 1;
        }
        // No api_key_updates: imported providers arrive keyless and the user
        // re-enters keys in AI settings (flagged via hasApiKey in the preview).
        ai_storage
            .save_providers(&providers, &HashMap::new(), &[])
            .map_err(|error| format!("Failed to save imported AI providers: {error}"))?;
    }

    // UI prefs: localStorage lives in the webview, so the backend only picks
    // the selected entries that are missing locally and hands them back for
    // the frontend to write.
    let mut ui_prefs_to_apply: Option<BTreeMap<String, String>> = None;
    if let Some(indices) = &selection.ui_prefs {
        let entries: Vec<(&String, &String)> = bundle.ui_prefs.iter().collect();
        let mut picked = BTreeMap::new();
        for &index in indices {
            let Some(&(key, value)) = entries.get(index) else {
                continue;
            };
            if existing_ui_pref_keys.contains(key) {
                continue;
            }
            picked.insert(key.clone(), value.clone());
            counts.ui_prefs += 1;
        }
        ui_prefs_to_apply = Some(picked);
    }

    Ok(WorkspaceBundleImportResult {
        preview,
        counts: Some(counts),
        ui_prefs: ui_prefs_to_apply,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::models::ConnectionConfig;
    use uuid::Uuid;

    fn sample_bundle() -> WorkspaceBundle {
        WorkspaceBundle {
            format: BUNDLE_FORMAT.to_string(),
            version: BUNDLE_VERSION,
            exported_at: "2026-09-21T00:00:00Z".to_string(),
            connections: vec![],
            sql_favorites: vec![],
            schedules: vec![],
            ai_providers: vec![],
            ui_prefs: BTreeMap::new(),
        }
    }

    static KEYRING_INIT: std::sync::Once = std::sync::Once::new();

    fn use_mock_keyring() {
        KEYRING_INIT.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    /// Acceptance round-trip: export → delete the connection → import → the
    /// connection is restored with its original id, sans password, flagged.
    #[test]
    fn round_trip_restores_connection_without_password() {
        use_mock_keyring();
        let root = std::env::temp_dir().join(format!("tabler-bundle-rt-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        let conn_storage = ConnectionStorage::from_data_dir(root.clone()).unwrap();
        let mut favorites = SqlFavoritesStorage::from_data_dir(root.clone()).unwrap();
        let mut schedules = ScheduleStorage::from_data_dir(root.clone()).unwrap();
        let ai_storage = AIStorage::from_data_dir(root.clone()).unwrap();

        let connection = ConnectionConfig {
            id: "conn-1".to_string(),
            name: "Prod".to_string(),
            db_type: crate::database::models::DatabaseType::PostgreSQL,
            host: Some("db.local".to_string()),
            port: Some(5432),
            username: Some("deploy".to_string()),
            password: Some("super-secret".to_string()),
            database: Some("app".to_string()),
            ..ConnectionConfig::default()
        };
        conn_storage.save_connection(&connection).unwrap();
        favorites
            .save(SqlFavorite {
                id: "fav-1".to_string(),
                name: "Health check".to_string(),
                description: None,
                sql: "select 1".to_string(),
                tags: vec![],
                connection_id: Some("conn-1".to_string()),
                database: None,
                created_at: String::new(),
                updated_at: String::new(),
            })
            .unwrap();

        let bundle_path = root.join("workspace.tabler-bundle");
        export_workspace_bundle_core(
            bundle_path.to_str().unwrap(),
            &conn_storage,
            &favorites,
            &schedules,
            &ai_storage,
            BTreeMap::from([
                (
                    "tabler.activeTheme".to_string(),
                    "tabler.midnight".to_string(),
                ),
                ("tabler.connectionGroups".to_string(), "[]".to_string()),
            ]),
        )
        .unwrap();

        // Secrets never reach the file.
        let raw = std::fs::read_to_string(&bundle_path).unwrap();
        assert!(!raw.contains("super-secret"));
        assert!(raw.contains("\"hasPassword\":true") || raw.contains("\"hasPassword\": true"));

        // Delete the connection and the favorite, then preview.
        conn_storage.delete_connection("conn-1").unwrap();
        favorites.delete("fav-1").unwrap();
        assert!(conn_storage.load_connections().unwrap().is_empty());

        let preview = import_workspace_bundle_core(
            bundle_path.to_str().unwrap(),
            None,
            &conn_storage,
            &mut favorites,
            &mut schedules,
            &ai_storage,
            // Simulate the importer already having one of the bundled keys.
            HashSet::from(["tabler.activeTheme".to_string()]),
        )
        .unwrap();
        assert!(preview.counts.is_none());
        assert_eq!(preview.preview.connections.len(), 1);
        assert!(!preview.preview.connections[0].exists);
        assert!(preview.preview.connections[0].needs_password);
        assert_eq!(preview.preview.sql_favorites.len(), 1);
        assert!(!preview.preview.sql_favorites[0].exists);

        // UI prefs: the key the importer already has is flagged, the other is not.
        assert_eq!(preview.preview.ui_prefs.len(), 2);
        assert!(preview.preview.ui_prefs[0].exists);
        assert!(!preview.preview.ui_prefs[1].exists);
        assert!(preview.ui_prefs.is_none());
        // Selective import: everything.
        let result = import_workspace_bundle_core(
            bundle_path.to_str().unwrap(),
            Some(WorkspaceBundleSelection {
                connections: Some(vec![0]),
                sql_favorites: Some(vec![0]),
                schedules: Some(vec![]),
                ai_providers: Some(vec![]),
                ui_prefs: Some(vec![0, 1]),
            }),
            &conn_storage,
            &mut favorites,
            &mut schedules,
            &ai_storage,
            HashSet::from(["tabler.activeTheme".to_string()]),
        )
        .unwrap();
        let counts = result.counts.unwrap();
        assert_eq!(counts.connections, 1);
        assert_eq!(counts.sql_favorites, 1);

        // Only the missing key comes back for the frontend to write.
        assert_eq!(counts.ui_prefs, 1);
        let prefs = result.ui_prefs.unwrap();
        assert_eq!(prefs.len(), 1);
        assert_eq!(
            prefs.get("tabler.connectionGroups").map(String::as_str),
            Some("[]")
        );
        let restored = conn_storage.load_connections().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "conn-1");
        assert_eq!(restored[0].name, "Prod");
        assert!(restored[0].password.is_none());
        // The favorite came back still pointing at the restored connection.
        let favs = favorites.get_all();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].connection_id.as_deref(), Some("conn-1"));

        // Re-import is a no-op: dedup flags the rows as existing.
        let again = import_workspace_bundle_core(
            bundle_path.to_str().unwrap(),
            None,
            &conn_storage,
            &mut favorites,
            &mut schedules,
            &ai_storage,
            HashSet::from(["tabler.activeTheme".to_string()]),
        )
        .unwrap();
        assert!(again.preview.connections[0].exists);
        assert!(again.preview.sql_favorites[0].exists);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_wrong_format() {
        let dir = std::env::temp_dir().join(format!("tabler-bundle-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.tabler-bundle");
        std::fs::write(&path, r#"{"format":"other","version":1}"#).unwrap();
        let error = load_bundle(path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("Not a TableR workspace bundle"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_newer_version() {
        let mut bundle = sample_bundle();
        bundle.version = BUNDLE_VERSION + 1;
        let dir = std::env::temp_dir().join(format!("tabler-bundle-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("newer.tabler-bundle");
        std::fs::write(&path, serde_json::to_string(&bundle).unwrap()).unwrap();
        let error = load_bundle(path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("newer than this app supports"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
