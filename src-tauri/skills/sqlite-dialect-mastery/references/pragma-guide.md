# SQLite PRAGMA guide — the layer the main skill does not cover inline

The main `sqlite-dialect-mastery` skill covers the SQL surface (ALTER limits, affinity,
upsert, WAL and `busy_timeout` for concurrency). This reference is the pragmas and file
behavior around that surface: typing that enforces, space that shrinks, and backups that
are actually consistent.

## `STRICT` tables — types that enforce (3.37+)

Column types in SQLite are affinity, not enforcement — unless the table is declared
`STRICT`:

```sql
CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL,
    amount ANY
) STRICT;
```

- A `STRICT` table accepts only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, or `ANY`
  columns; `VARCHAR(10)` is an error, not an affinity hint.
- Inserting `'hello'` into an `INTEGER` column fails instead of storing it. `ANY`
  columns keep the old permissive behavior.
- Requires SQLite 3.37.0 (2021-11). On older builds the keyword is a syntax error —
  check `sqlite_version()` before generating a `STRICT` DDL.
- One subtlety: in `STRICT` tables, `NaN` is rejected, and `REAL` columns reject text.

## VACUUM and file bloat

- Deleting rows does not shrink the file — freed pages go to a free list and stay
  allocated. After a bulk delete, the file is the size of the peak, not the size of the
  data.
- `VACUUM;` rebuilds the database file and reclaims the space. Costs: it needs roughly
  **2× the file size** in free disk space temporarily, it rewrites every page (slow on
  large files), and it **cannot run inside a transaction**.
- `VACUUM INTO 'backup.db';` (3.27+) builds a fresh, defragmented, **consistent copy**
  of the database into a new file — this is both the compaction and the safe-backup
  command in one.
- `PRAGMA auto_vacuum = INCREMENTAL` (set when the database is empty) plus
  `PRAGMA incremental_vacuum;` returns pages to the OS incrementally, avoiding the
  full-rewrite cost — at a small performance price on writes. It must be enabled before
  the database has content; toggling it later requires a full `VACUUM` first.

## Backup safety

- **Never copy a live database file** with `cp`/file-copy — you capture whatever mix of
  pages, `-wal`, and `-shm` state happens to exist, which can be a torn, unrecoverable
  snapshot. If WAL is enabled, the `-wal` and `-shm` sidecar files hold committed
  transactions that exist nowhere in the main file.
- Safe options, in order of preference:
  1. `VACUUM INTO 'backup.db';` — consistent, compacted, single new file.
  2. `sqlite3 main.db ".backup 'backup.db'"` — consistent online copy, no compaction.
  3. Stop all writers, then `PRAGMA wal_checkpoint(TRUNCATE);` and copy — acceptable
     only when no other connection can write.

## Durability: `synchronous`

Controls the fsync cadence. Meaningful settings, cheapest first:

- `PRAGMA synchronous = OFF;` — no syncing; a power loss can corrupt. Never suggest.
- `PRAGMA synchronous = NORMAL;` — the right pairing with WAL: commits are durable
  against application crashes, and only a power loss can lose recent transactions
  (never corrupt in WAL mode). This is the recommended default with WAL.
- `PRAGMA synchronous = FULL;` — syncs on every commit; the pre-WAL default. Costs a
  disk round-trip per commit; use when durability against power loss outweighs write
  throughput.
- `EXTRA` exists (adds directory-sync for rename durability); rarely worth it.

## Planner and memory pragmas

- `PRAGMA optimize;` — runs a cheap, targeted `ANALYZE` on tables whose statistics are
  stale. Run it **before closing a long-lived connection** (the documented pattern);
  it is not a substitute for `ANALYZE` after a massive data load — do a full
  `ANALYZE;` there.
- `PRAGMA cache_size = -64000;` — page cache in kibibytes (negative = KiB). The default
  is small (about 2 MB); a larger cache changes plan behavior for repeated scans.
  Memory is per-connection — do not set this large on a pooled, multi-connection app.
- `PRAGMA temp_store = MEMORY;` — keeps sorts and temp tables in RAM. Faster, and it
  removes temp-file churn; on huge sorts it can trade a disk spill for an OOM, so pair
  it with realistic row counts.
- `PRAGMA user_version = 3;` — a 32-bit integer slot for your own schema version.
  The `migration-authoring` skill's idempotent-DDL pattern can key off it instead of a
  tracking table: read with `PRAGMA user_version;`, write on each applied step.
