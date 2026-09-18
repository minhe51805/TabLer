---
name: no-update-without-where
description: Blocks an UPDATE that has no WHERE clause - it would rewrite every row.
enabled: true
event: pre_write
pattern: (?is)\bupdate\s+[\w\[\]."`]+\s+set\b
pattern-not: (?is)\bwhere\b
action: block
---

This UPDATE has no WHERE clause, so it would rewrite every row in the table.

Do this instead:

1. Run the SELECT for the target rows first and report the row count.
2. Add the explicit WHERE predicate and re-check the count.
3. Confirm the expected row count with preview_write before applying the change.
