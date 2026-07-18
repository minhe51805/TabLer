# TableR Security Threat Model

> Work item: SEC-001
> Baseline: v0.1.4b / Sprint 0A
> Updated: 2026-07-18
> Status: Initial review

## Scope

This model covers the desktop application, local persisted state, database connections, SQL execution, AI providers, MCP, deep links, plugins, update artifacts, and helper processes started by TableR.

Out of scope for this baseline:

- Security of database servers and third-party AI providers themselves.
- A compromised operating-system administrator account.
- Apple/Windows code-signing infrastructure that is not yet configured.

## Protected Assets

- Database passwords, API keys, certificates, SSH keys, MCP tokens, and provider credentials.
- Connection metadata, database schemas, SQL text, query results, and AI conversations.
- Integrity of reviewed SQL, migrations, imports, exports, and updater artifacts.
- User intent: selected connection, database, schema, table, row, and access policy.
- Availability of active sessions and local workspace state.

## Trust Boundaries

1. React UI to Tauri command boundary.
2. Tauri backend to database/network driver boundary.
3. Local process to OS keyring and application-data directory.
4. TableR to AI provider endpoints.
5. MCP client to TableR's local HTTP service.
6. Deep-link sender to TableR parser and navigation actions.
7. Plugin registry/bundle to managed plugin runtime.
8. TableR to shell commands, SSH tunnels, proxy helpers, and future cloud-tunnel helpers.
9. GitHub release/update metadata to the installed application.

## Verified Existing Controls

| Control | Evidence | Current assessment |
| --- | --- | --- |
| Connection passwords excluded from JSON | `src-tauri/src/storage/connection_storage.rs` clears `password` before atomic file write | Present |
| Connection passwords stored in OS keyring | `ConnectionStorage` uses the `keyring` crate per connection ID | Present; migration/failure policy pending |
| MCP bearer tokens not stored in plaintext | `src-tauri/src/mcp_security.rs` stores salted hashes | Present |
| MCP connection and permission bounds | Token permission, connection allowlist, expiry, revocation, and connection policy checks | Present |
| MCP request rate limiting | Per-token limiter in `src-tauri/src/mcp_local.rs` | Present; abuse test expansion pending |
| Credential-bearing deep links rejected | `src-tauri/src/commands/deep_link.rs` rejects URL credentials and secret query keys | Present |
| Plugin registry requires HTTPS | Registry URL validation in `src-tauri/src/commands/plugins.rs` | Present |
| Plugin bundle path and manifest validation | Managed directory, ID, capability, permission, compatibility, and file checks | Present; sandbox remains limited |
| Atomic local JSON writes | Storage modules use backup-aware atomic file helpers | Present; versioned migration pending |

## Threat Register

| ID | Threat | Impact | Existing control | Required mitigation | Owner / target |
| --- | --- | --- | --- | --- | --- |
| SEC-T01 | Credential leaks through logs, exports, crash data, clipboard, or screenshots | Critical | Password excluded from connection JSON; some redaction exists | Central redaction type, sensitive-field tests, diagnostic bundle review | OBS-001 / CONN-001 |
| SEC-T02 | Keyring unavailable, locked, or loses an entry | High | Errors are returned; plaintext fallback is not used | Explicit recovery UX, migration tests, no silent plaintext fallback | MIG-001 / CONN-001 |
| SEC-T03 | `pre_connect_script` executes attacker-controlled shell content | Critical | Requires stored connection configuration | Explicit opt-in trust prompt, command preview, environment minimization, timeout, output redaction, policy to disable | CONN-002 |
| SEC-T04 | AI provider receives schema or row data without informed consent | Critical | Provider settings include data/schema controls | Central egress policy, per-provider preview, redaction, zero-read Data Off tests | AI-005 |
| SEC-T05 | Agent or MCP bypasses safe mode or targets the wrong connection/object | Critical | MCP policy and reviewed SQL paths exist | One execution/capability contract, qualified object identity, cross-entry-point tests | CAP-002 / QUERY-001 |
| SEC-T06 | MCP token theft, replay, scope bypass, or localhost abuse | Critical | Salted token hash, expiry, revocation, allowlist, rate limit | Pairing lifecycle, rotation, active-request cancellation, origin/session controls, abuse suite | MCP-001 / MCP-002 |
| SEC-T07 | Malicious deep link runs SQL or changes state without clear consent | High | Strict parser rejects credentials and unknown actions | Action allowlist, length limits, confirmation for stateful actions, fuzz/property tests | CAP-002 / QUERY-001 |
| SEC-T08 | Malicious or replaced plugin accesses unintended data/network/files | Critical | Manifest validation and managed bundle directory | Versioned permissions, runtime limits, signed metadata, malicious-plugin fixtures, crash isolation | PLUG-001 |
| SEC-T09 | Registry/update supply-chain compromise installs altered artifacts | Critical | HTTPS and updater public key are configured | Checksums, signature verification, provenance/SBOM, pinned release contract, rollback drill | REL-001 |
| SEC-T10 | SQL injection through table, column, filter, order, or agent-generated identifiers | Critical | Driver-specific quoting/sanitization and prepared parameters on some drivers | Capability-gated parameters, identifier property tests, no guessed schema fields | CAP-001 / QUERY-001 / AI-003 |
| SEC-T11 | Cancellation only stops UI while server query keeps running | High | Command timeouts exist | Driver cancellation contract, visible uncertain state, cleanup/reconnect policy | QUERY-002 |
| SEC-T12 | Imported file causes memory exhaustion, parser abuse, or formula injection on export | High | Current import has 50 MB cap | Streaming parser limits, malformed corpus, bounded fields, spreadsheet-safe export option | IO-001 / IO-002 |
| SEC-T13 | Workspace sync exposes secrets or resolves conflicts destructively | Critical | Sync work is not complete | End-to-end encryption, secret exclusion by default, deterministic tombstones/conflicts | SYNC-001 / SYNC-002 |
| SEC-T14 | Persisted-state migration corrupts connections or weakens policy | Critical | Backup-aware JSON reads/writes exist | Versioned migration, pre-migration backup, failure injection, downgrade policy | MIG-001 / MIG-002 |
| SEC-T15 | Unsigned desktop artifact is replaced or blocked by the OS | High | GitHub release workflow and checksums can be verified | Explicit unsigned warning; signing/notarization remains an external blocker | REL-001 |

## Security Invariants

- No secret is written to application JSON, logs, diagnostics, telemetry, release metadata, or plugin manifests.
- Data Off means no live database read by AI, including metadata reads.
- A UI-hidden operation is still rejected by the backend when the capability or policy disallows it.
- Every write is bound to an explicit connection and qualified database object identity.
- Plugins and MCP clients receive no ambient authority.
- A failed or cancelled operation reports whether server-side completion is known, rolled back, partial, or uncertain.
- Unsigned artifacts are never described as trusted or notarized.

## Accepted Risks at Baseline

| Risk | Reason temporarily accepted | Expiry/review |
| --- | --- | --- |
| macOS build is unsigned | Apple credentials and budget are unavailable | Every release gate |
| Query cancellation may be client-side only | Drivers do not expose one cancellation contract yet | QUERY-002 |
| `pre_connect_script` has broad shell authority | Existing feature; hardening is not yet implemented | CONN-002; no scope expansion before then |
| Plugin sandbox is declarative/validation-based | Plugin SDK v2 is scheduled later in the train | PLUG-001 |

## Review Triggers

Update this model when TableR adds a driver, credential source, AI provider, externally reachable service, deep-link action, plugin permission, helper process, sync provider, updater trust mechanism, or persisted sensitive field.

SEC-001 is complete only after this model is reviewed alongside CAP-001 and all Critical threats have a tracked mitigation or explicit accepted-risk owner.
