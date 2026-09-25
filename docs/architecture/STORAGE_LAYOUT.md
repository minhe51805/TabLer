# Storage layout

Where TableR keeps state on disk — the map a new contributor needs before
touching `src-tauri/src/storage/` or `agent_memory.rs`.

## Roots

Two roots, never mixed:

| Root                                                                                                                   | Contents                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `<data_dir>` (platform app-data — `%APPDATA%/TableR`, `~/Library/Application Support/TableR`, `~/.local/share/tabler`) | Everything TableR owns: connections, query history, schedules, memory, checkpoints, skills/rules. Resolved by `utils::paths::resolve_data_dir`. |
| Project workspace                                                                                                      | `.claude/` (gitignored agent assets) and `plans/` (gitignored local plans) — **not** app data; see AGENTS.md §8.                                |

## Under `<data_dir>` — what lives where

| Path                         | Owner                            | Format                                                                                     |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `connections/`               | `storage/connection_storage.rs`  | Encrypted credentials + connection metadata                                                |
| `query-history/`             | `query_history.rs`               | Executed statements per connection                                                         |
| `schedules/`                 | `storage/schedule_storage.rs`    | `P10` scheduled agent tasks + run outcomes                                                 |
| `agent-memory/<conn>/<db>/`  | `agent_memory.rs`                | `MEMORY.md` per connection/database — **plaintext by design** (see §6a of AGENT_SKILLS.md) |
| `rewind-checkpoints/<conn>/` | `storage/checkpoint_store.rs`    | `*.chk` — AES-256-GCM `RewindCheckpoint` payloads (see REWIND_CHECKPOINTS.md)              |
| `skills/`, `rules/`          | `ai_skills.rs`, `agent_rules.rs` | `SKILL.md` / `RULE.md` packs the in-app agent loads                                        |
| `ai-workspace/`              | `ai_workspace_cache.rs`          | Workspace cache + history                                                                  |
| `plugins/`                   | `storage/plugin_storage.rs`      | Installed driver plugin state                                                              |
| `mcp/`                       | `storage/mcp_storage.rs`         | MCP server config                                                                          |
| `tabs/`                      | `storage/tab_persistence.rs`     | Open tab + workspace state                                                                 |

Sub-directories that carry secrets are created `0700` on Unix; Windows relies
on the profile ACL (owner-only by default).

## Patterns every storage module follows

1. **Atomic writes** — staging file + `rename`, never `fs::write` directly to
   the live path (a crash mid-write must not tear the file).
2. **Symlink refusal** — `symlink_metadata` checked before writing through a
   path the app does not own (see `write_memory_file` for the reference impl).
3. **Slug sanitization** — anything that becomes a filename (memory names,
   checkpoint ids) goes through a charset allowlist; `..`/`/`/`\\` rejected.
4. **`_in(data_dir)` test seam** — every public write/read function has a
   `data_dir`-parameterized twin so unit tests never touch the real data dir.
   Convention: `save_thing()` resolves the dir, `save_thing_in(dir, …)` does
   the work.
5. **Encryption at rest for anything sensitive** — AES-256-GCM via
   `commands/checkpoint_crypto.rs` (data key in OS keyring). Plaintext is the
   deliberate exception for files the user owns and edits (MEMORY.md,
   SKILL.md) — document why before adding another.

## Storage is not

- **Not a cache of query results** — `query_history` stores statements, not
  row data; `ai_workspace_cache` is keyed to a workspace snapshot, not the DB.
- **Not a backup** — rewind checkpoints cover grid writes only, and expire;
  they are not a dump.
- **Not syncable across machines** — connection ids and checkpoint AAD are
  device-scoped (keyring key is per-device).
