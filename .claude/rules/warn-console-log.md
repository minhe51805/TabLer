---
name: warn-console-log
enabled: true
event: write
pattern: \n\s*console\.(log|debug)\(
action: warn
---

`console.log` / `console.debug` left in frontend source.

The frontend logs through the project logger so messages carry a level and reach the
in-app log surface; a bare `console.log` is invisible to users reporting a bug and is
also what `eslint --max-warnings=0` rejects in CI. Remove it, or switch it to the
project logger.

This rule is a warning, not a block: a temporary `console.log` while debugging is a
legitimate step, and the pre-commit lint is the real gate.
