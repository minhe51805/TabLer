use crate::storage::tab_persistence::{PersistedTab, TabPersistence};
use tauri::State;

#[tauri::command]
pub async fn save_tabs(
    connection_id: String,
    tabs_json: String,
    tab_storage: State<'_, TabPersistence>,
) -> Result<(), crate::error::AppError> {
    let tabs: Vec<PersistedTab> =
        serde_json::from_str(&tabs_json).map_err(|e| format!("Failed to parse tabs JSON: {e}"))?;
    tab_storage
        .save_tabs(&connection_id, tabs)
        .map_err(|e| format!("Failed to save tabs: {e}"))
        .map_err(crate::error::AppError::from)
}

#[tauri::command]
pub async fn load_tabs(
    connection_id: String,
    tab_storage: State<'_, TabPersistence>,
) -> Result<Vec<PersistedTab>, crate::error::AppError> {
    tab_storage
        .load_tabs(&connection_id)
        .map_err(|e| format!("Failed to load tabs: {e}"))
        .map_err(crate::error::AppError::from)
}

#[tauri::command]
pub async fn delete_tabs(
    connection_id: String,
    tab_storage: State<'_, TabPersistence>,
) -> Result<(), crate::error::AppError> {
    tab_storage
        .delete_tabs(&connection_id)
        .map_err(|e| format!("Failed to delete tabs: {e}"))
        .map_err(crate::error::AppError::from)
}
