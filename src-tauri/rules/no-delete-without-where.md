---
name: no-delete-without-where
description: Blocks a DELETE that has no WHERE clause - it would empty the table.
enabled: true
event: pre_write
pattern: (?is)\bdelete\s+from\b
pattern-not: (?is)\bwhere\b
action: block
---

This DELETE has no WHERE clause, so it would remove every row in the table.

Do this instead:

1. Run the SELECT that proves which rows you intend to delete and show the row count.
2. Add the explicit WHERE predicate, then re-run the row count to confirm it matches.
3. If the user really asked to empty the table, ask them for confirmation first and
   suggest a /backup checkpoint before running it.
