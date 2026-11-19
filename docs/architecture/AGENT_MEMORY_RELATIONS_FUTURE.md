# Future direction — typed relations for agent memory and glossary

**Status:** direction note only; no code in this change implements it.

## Where this came from

A sweep of third-party agent-skill catalogs (hub.cocoloop.cn, round 2 — see the local
`plans/261031-1010-agent-dev-skills/PLAN.md`) surfaced an `ontology` skill: a typed
knowledge graph (entity / relation / constraint) offered as agent memory with
cross-skill state sharing. The hub package itself is file-CRUD prose and cannot run
inside this app; the _idea_, however, maps onto a real gap.

## The gap it would fill

Agent memory today (`agent_memory.rs`) is a flat set of markdown entries per
connection, and the glossary (`semantic_storage.rs`) is term → definition. Both answer
"what do I know about X" but neither answers "how does X relate to Y" — the question
behind most schema-adjacent follow-ups ("which tables reference this lookup?", "what
depends on the amount-in-cents convention?"). Today the agent reconstructs relations
from prose each run.

## What a native version would look like

- Entity types mirroring the workspace: `Table`, `Column`, `Convention`, `GlossaryTerm`,
  `VerifiedFinding` — not free-form nodes.
- Typed relations with the small closed vocabulary the data model already implies:
  `references`, `owned_by`, `contradicts`, `supersedes`, `verified_against`.
- Constraint validation at write time (a `Column` must belong to a `Table`; a
  `contradicts` edge requires both endpoints to exist) — the part that makes the graph
  _verifiable_ rather than another pile of prose.
- Storage in the existing SQLite workspace cache with the schema-version machinery
  (`storage/migrations.rs`), not files.
- Input gating through `content_gate.rs` exactly as memory does today.

## Why it is not in this change

- The agent's memory tools (`save_memory`, `read_memory`, `remember_term`) and the
  glossary UI already cover the flat cases; a typed layer changes the write path, the
  read path, and the manager UI — a feature with its own plan, not a skill-pack edit.
- The hub's file-CRUD approach is the wrong shape for this app: memory lives behind
  Rust commands, and the seeder contract keeps compiled content out of user-writable
  flows.
- Sequencing: the memory-taxonomy prompt change shipped in the same round is the cheap
  80%; relations are worth building once there is evidence the flat memory is actually
  filling up with relation-shaped prose.

## Revisit trigger

Revisit when either holds: (a) memory entries per connection routinely exceed the
24-entry index cap with relation-style content ("X means Y for table Z"), or (b) a
user-facing feature needs cross-entity queries the glossary cannot express.
