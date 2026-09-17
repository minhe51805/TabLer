---
name: require-parameterized-literals
description: Warns on dynamic SQL built by string concatenation instead of parameters.
enabled: true
event: pre_write
pattern: (?is)(\bexec\s*\(\s*@|sp_executesql|\bexecute\s+immediate|'\s*\+\s*@\w+|@\w+\s*\+\s*')
scan: raw
action: warn
---

A statement assembled by concatenating values into SQL text is the classic injection
and correctness hazard: the value can change the statement's meaning, and any
embedded quote breaks it outright.

Do this instead:

- Pass values as typed parameters (`sp_executesql @sql, N'@id int', @id`).
- Only identifiers may be concatenated, and only after validating them against the
  real object names from `sys.*`.
