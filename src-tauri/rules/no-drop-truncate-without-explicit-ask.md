---
name: no-drop-truncate-without-explicit-ask
description: Requires approval for DROP/TRUNCATE - destructive DDL the user rarely asked for.
enabled: true
event: pre_write
pattern: (?is)\b(drop\s+(table|view|index|schema|database)|truncate\s+table)\b
action: require_approval
---

This statement destroys an object or all of its rows. That is rarely what the user
meant, so it needs explicit approval before it runs.

Do this instead:

1. Restate the request in one line: which object, and what should be gone afterwards.
2. Offer the reversible alternative first (rename, soft-delete, drop the newly created
   object you just added).
3. Suggest a /backup checkpoint, then wait for the user's confirmation.
