---
name: require-transaction-for-multi-statement-write
description: Warns when a batch writes more than once without an explicit transaction.
enabled: true
event: pre_write
pattern: (?is)\b(insert\s+into|update\s+\w|delete\s+from)\b[\s\S]*?\b(insert\s+into|update\s+\w|delete\s+from)\b
pattern-not: (?is)\bbegin\s+(tran|transaction)\b
action: warn
---

This batch changes data in more than one statement with no explicit transaction, so a
failure part-way through leaves the table half-updated.

Do this instead:

1. Wrap the statements in `BEGIN TRAN` … `COMMIT`.
2. Verify the affected counts inside the transaction before committing.
3. Keep the rollback path written down (a `/backup` checkpoint covers the file-level
   undo).
