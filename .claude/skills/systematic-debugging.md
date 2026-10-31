---
name: systematic-debugging
description: Use when debugging any TableR bug, test failure, or unexpected behavior — before proposing fixes. Triggers on "why does this fail", "this is broken", a red CI gate, a wrong agent answer, or any fix that did not hold. Not for green-field feature work (use the plans/ convention instead).
version: 1.0.0
license: MIT
---

# Systematic Debugging (TableR adaptation)

Adapted from the obra/superpowers-skills lineage (MIT). The Iron Law is the skill:

```
NO FIXES WITHOUT ROOT-CAUSE INVESTIGATION FIRST.
NO INVESTIGATION WITHOUT CONTEXT RECALL FIRST.
```

A symptom patch that passes the test it was written for while the real cause survives
is a regression on a timer.

## Phase 0 — Context recall (mandatory first step)

Before touching anything: what do we already know?

1. Extract the signal from the failure: error class, component, layer (frontend, Tauri
   command, driver, gateway).
2. Check what this repo has already recorded: AGENTS.md §5 hard-won facts, `plans/`
   documents, memory entries, and the session's own earlier findings. Several classes of
   bug here are already solved and written down — stale snapshots, dirty-tree counting,
   bytes-vs-lines confusion, "cố tình không làm" claims that per-item verification
   refutes.
3. If a prior finding applies, apply it and say so. If it partially applies, use it as
   the starting point. If nothing matches, proceed — and record the solution when found.

## Phase 1 — Root-cause investigation

- Read the actual error completely — line numbers, codes, the statement that failed.
- Reproduce deterministically. A bug you cannot trigger on demand is a bug you cannot
  verify a fix for; gather more data instead of guessing.
- Check what changed: `git log`/`git diff` around the failing area, new dependencies,
  config, environment. This repo's own history produced surprises this way (a Tauri CLI
  bundling change made sidecars vanish; a CSS cascade rule made overlays transparent).
- In multi-component paths (UI → command → gateway → driver → engine), instrument the
  boundaries before proposing fixes: what enters, what exits, what the engine actually
  received. The sandbox gateway's own parser is a boundary that has refused statements
  the engine would have accepted — check which layer said no.
- Trace the bad value to its origin; fix at the source, not where it surfaced.

## Phase 2 — Pattern analysis

- Find the working analogue in this codebase and read it fully — do not skim. Compare
  against the broken path and list every difference, however small.
- Check dependencies and assumptions: feature flags, dialect mappings, contract caps
  (the skill validator mirrors runtime limits that silently truncate, not error).

## Phase 3 — Hypothesis and minimal test

- State one hypothesis with its reason: "X fails because Y, and here is the evidence."
- Test with the smallest possible change — one variable at a time. Never stack a second
  fix on an unverified first.
- Say "I don't understand X" when true. Do not launder a guess into a claim; a claim
  that has not run is not a finding.

## Phase 4 — Implementation and verification

1. Write the failing test first — the simplest reproduction. A fix without a test that
   failed before it is unverifiable by this repo's own standards.
2. Implement one fix. No "while I'm here" improvements, no bundled refactors.
3. Verify: the new test passes, the existing gates stay green, and the reported outcome
   matches the command output.
4. If the fix does not hold: stop, count. Under three attempts → back to Phase 1 with
   what the failed fix taught. **Three or more → question the architecture** — fixes
   that each reveal new coupling in a different place are the signature of a design
   problem, and that discussion belongs to the user, not to fix attempt #4.

## Red flags — stop and return to Phase 0

- "Quick fix for now, investigate later."
- "Just try changing X and see if it works."
- "Skip the test, I'll verify by hand."
- "It's probably X, let me fix that."
- Reporting success without the command output that proves it.

## TableR-specific notes

- A `SANDBOX_DENIED` or parse error from the gateway is **evidence about the gateway**,
  not proof the engine rejects the statement — name the layer before blaming it.
- Row counts are evidence only when read back; a claimed count is a hypothesis.
- After any fix, run the matching local gate (frontend, Rust, or the agent-skill
  validator) and quote its output before claiming done.
