---
name: no-force-push-protected-branches
enabled: true
event: bash
pattern: git\s+push\s+[^\n]*--force[^\n]*\b(main|develop|master)\b|git\s+push\s+--force\s+origin\s+(main|develop|master)\b
action: block
---

Do not force-push `main` or `develop`.

`main` is the release branch and `develop` is the integration branch; a force-push
rewrites shared history and silently drops other people's commits. Force-pushing a
personal `Feat/*` or `fix/*` branch is fine and is not matched by this rule.

If a release tag must be re-pointed, force-update the **tag**, not the branch, and say
explicitly which tag moved and from which commit.
