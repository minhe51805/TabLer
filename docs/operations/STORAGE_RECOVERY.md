# Persisted State Recovery

TableR v0.1.5 introduces a versioned migration boundary for local application state. Migration runs before connection, AI, plugin, tab, and MCP stores are opened.

## Automatic behavior

- Legacy state is treated as storage schema v0.
- Before migration, TableR copies top-level persisted files into `storage-migration-backups/<migration-id>` under the TableR data directory.
- `storage-migration-journal.json` records an in-progress migration.
- A successful migration atomically writes `storage-schema.json` and removes the journal.
- If startup finds an unfinished journal, TableR restores the recorded snapshot before retrying.
- If the manifest or journal is corrupt, or the data was written by a newer unsupported schema version, startup stops without modifying persisted state.

Passwords remain in the operating-system credential store and are not part of JSON migration snapshots. Backup directories inherit the application data directory's local access controls.

## Operator recovery

1. Close every TableR window.
2. Copy the entire TableR data directory to a separate location before manual recovery.
3. Preserve `storage-schema.json`, `storage-migration-journal.json`, and `storage-migration-backups` when reporting an issue.
4. Reinstall the same or a newer TableR build. Do not install an older build when the message reports a newer storage schema.
5. If automatic recovery reports a missing snapshot, stop and restore the copied data directory instead of deleting the journal.

Never edit or delete migration files while TableR is running.
