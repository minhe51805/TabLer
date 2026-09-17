---
name: no-cross-database-write
description: Warns when a write targets a three-part name in another database.
enabled: true
event: pre_write
pattern: (?is)\b(insert\s+into|update|delete\s+from)\s+[\w\[\]]+\.[\w\[\]]+\.
action: warn
---

The write names a database other than the one this workspace is bound to. Cross-
database writes are easy to aim at the wrong environment (a staging name resolving to
production) and they are not covered by this workspace's checkpoint/backup.

Do this instead:

- Confirm the target database with the user before running it.
- Prefer rebinding the workspace to that database, so the write is scoped, backed up
  and auditable like every other change.
