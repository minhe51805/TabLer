---
name: no-lock-hints-on-write
description: Warns when a write carries an escalation lock hint.
enabled: true
event: pre_write
pattern: (?is)\b(update|delete\s+from|insert\s+into)\b[\s\S]{0,300}?\(\s*(updlock|holdlock|tablockx|tablock)\s*\)
action: warn
---

The write takes a lock hint that escalates locking (`UPDLOCK`, `HOLDLOCK`, `TABLOCKX`,
`TABLOCK`). On a busy table that blocks other sessions and can deadlock them.

Do this instead:

- Drop the hint and rely on the default row/key locking.
- Only keep it if the user asked for it, and say which concurrency problem it solves.
