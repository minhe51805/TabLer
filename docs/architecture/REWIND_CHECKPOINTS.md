# Rewind checkpoints

How TableR captures a pre-image before a grid write and can replay the inverse
to undo it — the "Rewind" feature (closes the TablePro gap).

## What it is

Before `update_table_cell`, `apply_table_updates_atomically`, or
`delete_table_rows` calls the driver, the command layer snapshots the rows the
write is about to change into an encrypted checkpoint file. The Tools menu in
the grid toolbar ("Rewind…") lists recent checkpoints; restoring one replays
the **inverse** operation through the same verified write commands.

| Write                      | Captured                         | Restore runs                                         |
| -------------------------- | -------------------------------- | ---------------------------------------------------- |
| `UPDATE` cell / edit queue | selector + full row (old values) | `apply_table_updates_atomically` with the old values |
| `DELETE` rows              | selector + full row              | `insert_table_rows_atomically` with captured rows    |
| `INSERT` rows              | selector (post-write keys)       | `delete_table_rows` with the captured selectors      |

`INSERT` checkpoints are not captured in v1 — an insert is self-undoable
(delete the row), and auto-increment PKs would need a post-write select.

## Storage layout

```
<data_dir>/rewind-checkpoints/<connection_id>/<checkpoint_id>.chk
```

Each file is a JSON `RewindCheckpoint` encrypted by
`commands/checkpoint_crypto.rs`: `TCK1 | nonce(12) | AES-256-GCM ciphertext`,
key stored once in the OS keyring under `TableR_DataKey`, AAD bound to the
connection id so a blob copied between connections fails authentication.

Writes go through staging-file + rename so a crash mid-write cannot leave a
half checkpoint, and the directory is `0700` on Unix. Retention is
`MAX_CHECKPOINTS_PER_CONNECTION = 20` per connection — oldest files are pruned
on save. `CHECKPOINT_TTL_MS` = 7 days; older checkpoints are flagged `expired`
in the list and refused at restore.

## Capture contract

`capture_rewind_checkpoint` in `commands/rewind.rs` is **best-effort**: the
driver method `select_rows_by_keys` (added on the `DatabaseDriver` trait) is
called per selector; engines that return `Err(unsupported)` simply produce no
checkpoint and the write proceeds. Implemented for SQLite, PostgreSQL and
MySQL; other engines write without a rewind option until their impl lands.

Empty captures (no row matched the selector) are skipped — the write will hit
`ensure_rows_affected` on its own anyway.

## Refusal layer

`restore_rewind_checkpoint` returns a structured outcome, never an opaque
string error:

```ts
{ restored: number | null, refusals: RefusalCode[] }
```

`RefusalCode` covers every reason a restore can be denied without touching the
database — `capabilityMissing`, `safeModeBlocked`, `connectionReadOnly`,
`checkpointExpired`, `connectionMismatch`, `emptyCheckpoint`, and
`rowDriftDetected` (the inverse write ran but affected fewer rows than the
checkpoint recorded — the checkpoint is **kept** so the user can reconcile
manually instead of pretending the restore happened).

On a verified restore the checkpoint file is deleted, so it cannot replay
stale values over newer data.

## Files

| Path                                              | Role                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `src-tauri/src/commands/rewind.rs`                | capture helper + list/restore/delete commands + refusal layer |
| `src-tauri/src/storage/checkpoint_store.rs`       | encrypted file store + retention + `expired` flag             |
| `src-tauri/src/commands/checkpoint_crypto.rs`     | AES-256-GCM envelope (shared with export checkpoints)         |
| `src-tauri/src/database/driver.rs`                | `select_rows_by_keys` trait method                            |
| `src/components/DataGrid/DataGridRewindModal.tsx` | checkpoint list + restore/delete UI                           |
| `src/components/DataGrid/rewind-copy.ts`          | per-language copy incl. refusal reasons                       |

## Invariants

- A checkpoint never blocks the write it was captured for (capture failures
  are logged, not surfaced).
- A restore can never silently partial-commit — `ensure_rows_affected`
  verifies the inverse write against the recorded row count.
- Restoring is itself gated by safe mode and `assert_write_allowed`, same as
  the original write.
