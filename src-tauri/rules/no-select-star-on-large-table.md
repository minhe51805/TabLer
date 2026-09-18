---
name: no-select-star-on-large-table
description: Warns on SELECT * - scans every column and can pull a huge result set.
enabled: true
event: pre_read
pattern: (?is)\bselect\s+\*\s+from\b
action: warn
---

`SELECT *` reads every column, so the engine cannot use a narrow covering index and
the result set can be far larger than the question needs.

Do this instead:

- Name the columns the answer actually needs.
- Add `TOP (n)` while exploring, and raise it only after the shape is known.
