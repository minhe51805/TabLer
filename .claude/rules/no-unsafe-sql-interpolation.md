---
name: no-unsafe-sql-interpolation
enabled: true
event: write
# `flags: i` instead of an inline `(?i)`: JavaScript RegExp has no inline-flag syntax, so
# `(?i)` makes the pattern uncompilable and the engine skips the rule (fail-open = inert).
# Two branches, because SQL is built by hand in both languages in this repo:
#   Rust   -> format!("SELECT ... {}", value)
#   TS/JS  -> `SELECT ... ${value}`
flags: i
pattern: (?:format!\(\s*"[^"]*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)[^"]*\{)|(?:`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)[^`]*\$\{)
action: warn
---

This looks like SQL built by string interpolation (`format!("... {}", x)` in Rust, or a
`` `... ${x}` `` template literal in TypeScript).

Interpolating a value into SQL makes the statement injectable, and it also breaks the
dialect contract: a value that needs quoting, an identifier that needs bracketing, or a
NULL comparison all behave differently per engine. Use a bound parameter, and if an
identifier genuinely must be dynamic, validate it against an allowlist first rather than
trusting the input.

The in-app agent has `run_parameterized_sql` and `check_sql` for exactly this reason —
the same discipline applies to hand-written Rust that builds SQL.
