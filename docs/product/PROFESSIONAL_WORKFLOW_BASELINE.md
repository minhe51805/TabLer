# TableR Professional Workflow Baseline

> Work item: PROD-001
> Baseline: v0.1.4b / Sprint 0A
> Updated: 2026-07-18
> Status: Initial internal baseline; moderated user evidence pending

## Primary User

The primary user for the v0.1.5 train is a software engineer or database-focused developer who regularly inspects production-like databases, writes SQL, edits small data sets, imports/exports data, and uses AI for investigation while retaining control over every database write.

Secondary users such as full-time DBAs, data analysts, and plugin authors inform specific workflows but do not silently expand committed scope.

## Reference Environment

The reproducible baseline uses:

- PostgreSQL and MySQL containers with the same commerce/support fixture.
- SQLite file containing an equivalent subset.
- At least 100 tables, 1,000 columns, foreign keys, views, indexes, JSON, binary, decimal, date/time, NULL, and long-text values.
- Tables sized at 100, 100,000, and 1,000,000 rows.
- Windows as the fast development lane; macOS and Linux as release-candidate lanes.
- Fixed screen profiles: 1280x800, 1440x900, 1920x1080, and one high-DPI profile.

Fixture creation and exact hardware are deliverables of TEST-002 and PERF-001. Until then, timing data is informative rather than a release gate.

## Top Professional Workflows

| ID | User outcome | Baseline TableR evidence | Current weakness | v0.1.5 success measure |
| --- | --- | --- | --- | --- |
| WF-01 | Save and reconnect securely | Connection launcher, OS keyring storage | Failure stages and secret recovery are unclear | Connect/reconnect succeeds or identifies the failing stage without exposing secrets |
| WF-02 | Find and open the correct object quickly | Explorer, tabs, deep links | Same-name identity and frecency are incomplete | Open qualified object from switcher without wrong-schema navigation |
| WF-03 | Write and execute SQL safely | Monaco editor, safe mode, query results | Execution paths and cancellation semantics differ | Editor/AI/MCP classify and execute the same SQL consistently |
| WF-04 | Browse large tables smoothly | Virtualized DataGrid and paging | Fast-scroll metadata/data races and selection gaps | Stable scrolling, loading, and selection on the reference large table |
| WF-05 | Edit data and recover mistakes | Inline edit, change tracking, some atomic queues | No unified range selection/undo model | Edit/paste/fill/delete preview and undo target the exact intended rows |
| WF-06 | Customize repeated table work | Column resize and filters | Order/visibility/pinning are not fully persisted | Qualified per-table layout restores before first usable render |
| WF-07 | Move large data safely | CSV preview/import and exports | 50 MB full-file preview; full-result export ambiguity | Stream 1 GB fixture with bounded memory, progress, cancel, and correct completeness |
| WF-08 | Inspect and change database structure | Structure view and reviewed SQL | Dialect support is over-broad and uneven | Capability-driven DDL preview/apply/refresh passes applicable Tier A fixtures |
| WF-09 | Diagnose users, locks, and activity | Basic Users & Roles and query presets | Privilege depth and server operations are incomplete | Explain effective access and safely stage admin operations on supported engines |
| WF-10 | Ask AI about live data with evidence | Agent tools, data permission, row links | Guessed columns, non-streaming responses, and uneven grounding | Stream answer, obey data policy, use verified schema, and navigate citations to source |

## Measurement

For every workflow record:

- Completion without assistance.
- Time on task.
- Wrong-object, wrong-row, or unsafe-action count.
- Error recovery success.
- Number of unclear states or dead ends.
- Crash, hang, visual overflow, or lost-state occurrence.
- User confidence score from 1 to 5 after completion.

P0 blockers:

- Data loss, wrong-target write, secret exposure, policy bypass, unrecoverable migration, or release artifact compromise.

P1 blockers:

- Core task cannot be completed, cancellation state is misleading, repeated crash/hang, inaccessible required action, or result/export silently differs from requested scope.

## Baseline Evidence State

This first revision is code-and-screenshot informed, not a claim of external validation. PROD-001 remains in Verification until:

1. TEST-002 creates reproducible fixtures.
2. One internal baseline run records all ten workflows.
3. At least three representative users complete the critical subset WF-01, WF-03, WF-04, WF-05, WF-07, and WF-10, or the lack of participants is recorded as an explicit product risk.
4. Findings are linked to roadmap work items rather than added as unbounded scope.

The same workflow IDs and fixtures are reused at every phase gate so improvement can be compared instead of described subjectively.
