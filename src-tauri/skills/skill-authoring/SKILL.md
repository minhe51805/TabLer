---
name: skill-authoring
description: This skill should be used when the user asks to "write a skill", "create a SKILL.md", "make a reusable procedure for the agent", or "add domain knowledge".
version: 1.0.0
license: MIT
---

# Skill Authoring

A skill is a folder of instructions the agent loads **on demand**, so it is the right
place to put repetitive, domain-specific procedure: how this company models soft deletes,
how to run a month-end close, the house style for a schema review. It is the wrong place
for one-off requests and for anything the agent can see in the schema itself.

## Shape of a skill

```
<skills root>/<skill-name>/
├── SKILL.md                  # required — frontmatter + instructions
├── references/*.md           # optional — detail loaded only when needed
└── scripts/*.sql             # optional — queries/procedures to run or adapt
```

Roots, in precedence order: the workspace `skills/` folder, then the global skills
folder. The **folder name must equal the `name:` in the frontmatter** — a mismatch makes
the skill undiscoverable, and it is the most common authoring mistake.

## Frontmatter

```yaml
---
name: month-end-close
description: This skill should be used when the user asks to "run month-end close", "reconcile the ledger", or "freeze the period".
version: 1.0.0
---
```

- `name` — lowercase, hyphens, matches the folder.
- `description` — the **trigger**. Write it in the third person, starting
  `This skill should be used when…`, and put the literal phrases a user would say in
  quotes. This is the only text the agent sees before deciding to load the skill, so a
  vague description means the skill never fires. Keep it under 200 characters — anything
  longer is truncated and the trailing triggers are lost.
- `version` — bump it when the instructions change.
- `allowed-tools` (optional) — restrict the tools available while this skill is active.
  Use it to make a read-only skill _provably_ read-only, e.g. a profiling skill lists
  `describe_table`, `run_readonly_sql`, `check_sql` and nothing that writes.

## Writing the body

Write in the imperative, addressed to the agent, and be concrete. The tests are: _could
another instance of the model follow this without asking a question?_ and _is any of this
already obvious from the schema?_

Include, in this order:

1. **When to use it** — one or two sentences, plus when _not_ to use it.
2. **The rules or steps**, numbered, each one actionable. Prefer "run the SELECT with the
   same `WHERE` first and report the count" over "be careful".
3. **A worked example** — a real query, a real command, a real expected output.
4. **What to report** — the exact facts the answer must contain, so success is checkable.
5. **See also** — the sibling skills to load next.

Keep the body lean (aim for 1,500–2,000 words). Move long catalogues into `references/`:
the agent loads a reference file explicitly with `read_skill_resource`, so detail there
costs nothing until it is needed. A body that inlines everything makes every load
expensive.

## Making a skill trustworthy

- **Cite a source for every claim.** Catalog view names, DMV names, parameter names —
  so the reader can verify rather than trust.
- **State the limit of the technique.** If a pattern is defeated by a case (a regex that
  a comment can bypass, a row count that is approximate), say so in the skill. A skill
  that overclaims is worse than no skill.
- **Never contradict the guardrail skills.** Safety instructions
  (`tsql-safety-guardrails`) win over any convenience instruction in a domain skill.
- **Do not restate the tool schemas.** The agent already has them; restating them wastes
  context and drifts out of date.

## Checklist before shipping

- [ ] Folder name equals `name:` in the frontmatter.
- [ ] Description is third person, has quoted trigger phrases, is under 200 characters.
- [ ] Body says when _not_ to use the skill.
- [ ] Every step is an action, not an adjective.
- [ ] Detail that is rarely needed lives in `references/`.
- [ ] `scripts/` holds only queries that are safe to run as written.
- [ ] A read-only skill declares `allowed-tools` without any write tool.

## See also

- `tsql-safety-guardrails` — the safety rules a new SQL skill must not contradict.
- `tsql-dialect-mastery` — an example of a well-scoped language skill.
