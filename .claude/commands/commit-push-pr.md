---
description: Commit, push, and open a PR against develop
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(gh pr create:*)
---

## Context

- Status: !`git status --short`
- Unstaged and staged diff: !`git diff HEAD --stat`
- Branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -5`

## Your task

1. **Never commit on `main` or `develop`.** If the current branch is one of those,
   create a working branch first. This repo's integration branch is `develop`;
   `Feat/*` and `fix/*` are the normal working branches.
2. Review the diff for anything that must not be committed: `.env`, credentials,
   build output, `dist/`, `src-tauri/target/`, personal agent state under `.claude/`
   that is still gitignored, and any file the user did not intend to include.
3. Stage the intended files and create a single commit with a conventional-commit
   subject: `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`, `test: …`.
   The body explains _why_, not _what_.
4. If agent assets changed (anything under `.claude/` or `src-tauri/skills/`), run
   `npm run check:agent-skills` before committing and report the result.
5. Push the branch to origin.
6. Open a PR against `develop` with `gh pr create` — a short summary, the checks you
   ran, and anything the reviewer must know. Do not target `main`.

Do all of the above in as few messages as possible. Report the PR URL at the end.
