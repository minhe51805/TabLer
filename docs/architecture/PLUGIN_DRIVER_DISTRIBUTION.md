# Driver Distribution Architecture (plugin-split)

This document is the single reference for how TableR packages its database
engines: which ship in the app, which move behind installable HTTP plugins, and
which are compiled behind Cargo features. It records the shipped design
(Phases 0-3.5) and the remaining plan for making native engines fully
downloadable (Phase 4, sidecar).

## 1. Goal

Keep the common engines built in and always available, while letting the app
ship leaner and let less-common engines be added without recompiling the whole
binary. The product-level target the epic started from:

> Keep SQL Server, MySQL, MongoDB, PostgreSQL, SQLite built in by default; move
> the other engines out so they can be downloaded/imported and connected to
> without shipping every driver in the base binary.

> Update — connection-experience default set. Independent of the backend
> `DriverDistribution` above, the UI now treats exactly SEVEN engines as usable
> out of the box (no plugin required): **MySQL, SQLite, SQL Server, PostgreSQL,
> MongoDB, Redis, DuckDB**. Every other engine (MariaDB, CockroachDB, Greenplum,
> Redshift, Vertica, Cassandra, LibSQL, ClickHouse, BigQuery, Snowflake,
> Cloudflare D1) is presented as plugin-gated: the connection picker and the
> Plugin Manager both list it under "needs a plugin / roadmap" until a matching
> driver plugin is installed and enabled. The single frontend source of truth is
> `BUILTIN_ENGINE_KEYS` in `src/utils/plugin-driver-runtime.ts`, consumed by
> `applyEngineRuntimeAvailability`, so no surface can disagree. The connection
> picker also exposes an **Install plugin** button so a plugin can be added right
> where a gated engine is shown. The backend `capabilities.rs` taxonomy is
> unchanged and still guards the connect path; an engine without an available
> plugin therefore stays gated in the UI until one exists.


Rust has no stable ABI, so "download a compiled Rust driver and load it at
runtime" is not possible in-process. That single fact splits the non-core
engines into two very different tracks (HTTP vs native), which is the core of
this architecture.

## 2. The taxonomy: `DriverDistribution`

Every engine is classified exactly once by `driver_distribution()` in
`src-tauri/src/database/capabilities.rs`. The match is exhaustive on purpose:
adding a new `DatabaseType` forces a packaging decision.

| Distribution   | Meaning | Engines |
|----------------|---------|---------|
| `builtin`      | Always compiled in; ships in every build. | MySQL, MariaDB, PostgreSQL, CockroachDB, Greenplum, Redshift, Vertica, SQLite, SQL Server (MSSQL), MongoDB |
| `plugin_http`  | HTTP/REST engines; the compiled driver is gated behind an installable plugin manifest (`declarative-http-v1`). | ClickHouse, BigQuery, Snowflake, Cloudflare D1, OpenSearch |
| `plugin_native`| Wire-protocol crate compiled behind a Cargo feature (off by default). The lean default build ships none of them; each is delivered as an installable out-of-process `driver-sidecar-v1` plugin, or linked back in with `--features <engine>-driver`. | DuckDB, Cassandra, Redis, LibSQL |

The classification is serialized into `docs/generated/driver-capabilities.json`
(field `distribution`) by the `generate_capability_matrix` example, and a Rust
test (`committed_json_matrix_matches_the_rust_catalog`) pins the file to the
source of truth. The frontend imports the same JSON, so both sides share one
matrix.

Why the built-in set is these ten: the product always ships five wire drivers —
MySQL, PostgreSQL, SQLite, SQL Server, MongoDB — and every other built-in engine
reuses one of those compiled drivers (MariaDB -> MySQL wire;
CockroachDB/Greenplum/Redshift/Vertica -> PostgreSQL wire). They cost nothing
extra to keep in-app.

## 3. Why HTTP vs native is the dividing line

- `plugin_http` engines talk plain HTTP/REST via `reqwest`. Their behavior can be
  driven from a declarative manifest, so the driver can be gated behind an
  installed, verified plugin and enabled without recompiling. This is exactly the
  "download and import to connect" model the goal asked for. OpenSearch has
  shipped this way from the start and is the reference implementation.
- `plugin_native` engines link a protocol crate (`duckdb` bundled C, `scylla`,
  `redis`, `libsql`). These cannot be added at runtime in-process because Rust
  has no stable ABI. The realistic options are (a) a feature-flag build that
  drops them (shipped, Phase 3) or (b) an out-of-process sidecar (planned,
  Phase 4).

## 4. What ships today (Phases 0-3.5)

### Phase 0 - Taxonomy foundation
- `DriverDistribution` enum + `driver_distribution()` + `distribution` field on
  the capability profile; matrix regenerated; frontend `DriverDistribution` type
  mirrors it; contract test binds the frontend set to the generated matrix.

### Phase 1 - Generalized the plugin host gate
- The `declarative-http-v1` validation gate accepts exactly the `plugin_http`
  protocol set, derived from the matrix (`is_declarative_http_protocol`) so the
  allow-list cannot drift from the taxonomy.

### Phase 2 - HTTP engines gated behind installable plugins
- `manager.rs` routes ClickHouse, BigQuery, Snowflake, Cloudflare D1 and
  OpenSearch through `require_installed_http_plugin(...)`: they only connect once
  a matching plugin is installed, enabled and verified.
- Four new plugin manifests (`plugins/{clickhouse,bigquery,snowflake,cloudflare-d1}-driver/`)
  plus the regenerated `plugin-registry.json` (6 packages, digests computed by
  `scripts/build-plugin-registry.mjs`, matching the Rust `compute_bundle_digest`).
- The frontend connection picker gates these engines on an installed driver via
  `PLUGIN_HTTP_PROTOCOLS` + `resolvePluginHttpDrivers`, and injects
  `plugin_id`/`plugin_driver_id` into the connection when selected.

### Phase 3 - Native drivers behind Cargo features
- `Cargo.toml` features: `duckdb-driver`, `cassandra-driver`, `redis-driver`,
  `libsql-driver`. Originally all in `default`; the native-distribution work
  (Phase 4g) flips `default` to empty so the shipped build is lean and these are
  opt-in (`--features <engine>-driver`), each dropping heavy deps (e.g. duckdb's
  bundled C). See section 5.
- `manager.rs` and `database/mod.rs` `cfg`-gate the driver modules, imports and
  `connect` arms. A dropped engine returns a clear
  "<Engine> support was not compiled into this build." error.
- Verified both ways: default `cargo test --lib` green;
  `cargo check --no-default-features` compiles without the four native crates.

### Phase 3.5 - Build-availability surfaced to the UI
Phase 3 made native drivers optional but nothing told the frontend which were
compiled in, so a lean build would still advertise a dropped engine and only
fail at connect. Closed the loop:
- Backend `compiled_native_driver_availability()` (evaluated with `cfg!`, never a
  const table) reports which `plugin_native` engines are linked, exposed via the
  `get_native_driver_availability` Tauri command. Tests pin the key set to the
  `plugin_native` taxonomy and pin the report to the active feature set.
- Frontend `PLUGIN_NATIVE_PROTOCOLS` + `isNativeDriverAvailable`; `ConnectionForm`
  loads the availability map once and marks an uncompiled native engine
  `supported: false`, which reuses the picker's existing accurate "Not available
  in this build yet" messaging (fail-open if the call fails; the backend still
  guards the connect path). Contract test binds `PLUGIN_NATIVE_PROTOCOLS` to the
  generated matrix.

## 5. Build variants (default is lean)

As of the native-distribution work the **default build is lean**: `default = []`
in `Cargo.toml`, so `cargo build --release` (and therefore `npm run build:release`,
which shells out to `tauri build`) links **none** of the four native crates. The
shipped app carries only the `builtin` engines; DuckDB, Cassandra, Redis and
LibSQL are delivered as installable `driver-sidecar-v1` plugins (section 7).

```
# Lean shipped build (no native crates) — this is the default:
cargo build --release
npm run build:release

# Add native engines back into the binary (any subset), e.g. everything:
cargo build --release --features duckdb-driver,cassandra-driver,redis-driver,libsql-driver
npm run build:release:full     # all four, via tauri build --features …
npm run tauri:full             # dev with all four linked in-process
```

`plugin_http` engines need no rebuild — install their plugin from the registry.
`builtin` engines are always present. In any build, the connection picker only
offers engines the running binary can actually drive (compiled in) **or** has a
verified sidecar plugin installed for.

## 6. Remaining work - Phase 4 (native sidecar)

To make native engines fully "download and connect" like the HTTP plugins, run
each native driver as an out-of-process sidecar the app talks to over IPC. This
sidesteps the missing Rust ABI: the sidecar is a standalone binary distributed
per-platform via the plugin registry, and the app speaks a stable protocol to
it rather than linking the crate.

Phase 4 lands as verified sub-phases. Status:

### Phase 4a - IPC protocol contract (done)
- `src-tauri/src/database/sidecar/protocol.rs`: `SIDECAR_PROTOCOL_VERSION =
  "driver-sidecar-v1"`, a `SidecarCall` enum mirroring every `DatabaseDriver`
  method one-to-one, typed `SidecarResponsePayload`/`SidecarError`, and the
  framed `HostFrame`/`SidecarFrame` messages (Request/Cancel/StreamChunk/
  StreamEnd/Shutdown). Every payload reuses the existing serde models, so host
  and sidecar share one definition. `mod.rs` provides newline-delimited JSON
  framing (`encode_frame`/`decode_frame`). Round-trip + framing tests pin it.

### Phase 4b - host-side proxy (done)
- `sidecar/client.rs` `SidecarClient`: transport-agnostic (any
  `AsyncRead`/`AsyncWrite`), with a writer task, a reader task, per-id oneshot
  correlation, unary-call timeout, cooperative cancellation (`call_cancellable`
  emits a `Cancel` frame), and streamed imports (`stream_import`). Unit-tested
  over an in-memory duplex with a fake sidecar (correlation, timeout,
  closed-connection, cancellation, streaming tally).
- `sidecar/driver.rs` `SidecarDriver`: implements the full `DatabaseDriver`
  trait by forwarding to `SidecarClient`, caches `current_database` for the
  synchronous accessor, and owns the child process (`kill_on_drop`, killed on
  `disconnect`). `spawn` negotiates the handshake then opens the connection.

### Phase 4d - runtime recognition + asset resolution (done)
- `capabilities::is_plugin_native_protocol` mirrors `is_declarative_http_protocol`
  for the `PluginNative` set (matrix-sourced, cannot drift).
- Manifest validation accepts `("driver-sidecar-v1", "stable"|"experimental")`,
  gating the protocol to a native engine and requiring the DB permissions.
- `sidecar::platform_target()` (`<os>-<arch>`) and
  `sidecar::sidecar_executable_path()` (`bin/<platform>/<driver_id>[.exe]`) locate
  the per-platform binary inside a verified bundle; digests reuse
  `compute_bundle_digest`. Frontend `PluginDriverContribution.runtime` union
  includes `driver-sidecar-v1`.

### Phase 4c - manager routing (done)
- `manager.rs` `connect_native_sidecar` mirrors `require_installed_http_plugin`:
  when a native crate feature is absent, the engine's fallback arm resolves a
  verified `driver-sidecar-v1` plugin (`resolve_active_sidecar`, which reuses the
  managed-location / enabled / verified / capability checks and adds a runtime
  guard + bundle dir), locates the per-platform binary, and spawns it as a
  `SidecarDriver`. The helper and arms are `#[cfg]`-gated to lean builds, so the
  default build is unchanged. Verified in both builds: default `cargo test --lib`
  (328 passed) and `cargo check --no-default-features` (lean build compiles the
  routing).

### Phase 4f - registry packaging + picker gating (done)
- `scripts/build-plugin-registry.mjs` is sidecar-ready: `computeBundleDigest`
  now hashes the *whole* bundle (semantic manifest, then every other file sorted
  by its forward-slash path as `path + 0x00 + u64LE(len) + contents`), byte-for-
  byte mirroring the Rust host's `compute_bundle_digest`. `collectBundleFiles`
  walks each bundle recursively and `buildAssets` publishes one download asset
  (`{path,url,sha256,size}`) per non-manifest file, so a `driver-sidecar-v1`
  bundle's per-platform binaries under `bin/<os>-<arch>/…` are covered by the
  integrity digest and downloadable at install time. Manifest-only bundles are
  unaffected (empty file list -> identical digest, `assets: []`), keeping the
  committed registry byte-stable (the `release-validation` determinism gate).
  Locked by `tests/scripts/build-plugin-registry.test.js` against an independent
  reference of the framing.
- Frontend picker gates native engines on an installed, verified sidecar plugin,
  generalizing the `plugin_http` gating to native (see
  `plugin-driver-runtime.ts` sidecar helpers + tests).

### Phase 4e - reference sidecar + end-to-end test (done)
- `src-tauri/src/bin/reference_sidecar.rs`: a real out-of-process
  `driver-sidecar-v1` binary. It plugs a concrete `SidecarBackend` (backed by the
  built-in SQLite driver, so it needs no external server and runs in CI) into the
  reusable `sidecar::server::serve` loop and speaks the framed protocol over
  stdio -- exactly as a downloaded per-platform native driver would. Built only
  under the `reference-sidecar` feature so normal app builds stay lean
  (`[[bin]] required-features = ["reference-sidecar"]`).
- `src-tauri/tests/sidecar_e2e.rs`: spawns that binary as a real OS process and
  drives it through the host `SidecarDriver::spawn` (spawn + handshake + connect),
  then round-trips `ping` / `execute_query` (create, insert) / `count_rows` /
  `list_tables` / `select`, and a clean `disconnect` that stops the child.
  Verified green: `cargo test --features reference-sidecar --test sidecar_e2e`
  (1 passed). Wired into CI as a step of the `rust` job in `.github/workflows/ci.yml`.
- Clippy hygiene for the feature matrix: the sidecar-resolution helpers
  (`resolve_active_sidecar`, `ResolvedSidecar`) are used only by the native
  fallback (`#[cfg(any(not(feature = "<native>-driver")))]`), so an all-features
  build (e.g. `npm run build:release:full`) sees them as dead code -- annotated
  `#[allow(dead_code)]` / `#[allow(unused_imports)]` so they stay compiled +
  unit-tested while `clippy --lib -- -D warnings` passes in every feature combo. The pre-existing `vendored-openssl` /
  `openssl-on-win32` SSH-tunnel cfgs are now declared in `[features]` so
  `unexpected_cfgs` no longer fails the same gate.

### Phase 4g - native distribution: lean default + sidecar plugins (done, packaging)
The mechanism (4a-4f) was complete but the shipped app still linked all four
native crates and no native plugins existed. Phase 4g makes the split real:
- `Cargo.toml` `default = []` -- the shipped `cargo build --release` /
  `npm run build:release` is now lean and links no native crate. Full builds are
  one command away: `npm run build:release:full` (release) / `npm run tauri:full`
  (dev), or `--features <engine>-driver` for any subset.
- Four native plugin bundles authored: `plugins/{duckdb,cassandra,redis,libsql}-driver/plugin.json`,
  each a `driver-sidecar-v1` adapter contributing its `PluginNative` protocol
  (`duckdb`/`cassandra`/`redis`/`libsql`) with the DB permissions the validator
  requires. `plugin-registry.json` regenerated to 10 packages; the five
  `plugin_http` manifests' digests are unchanged (determinism gate stays green).
- Four per-engine sidecar binaries: `src-tauri/src/bin/{duckdb,cassandra,redis,libsql}_sidecar.rs`,
  each gated behind its own `*-sidecar` feature (which pulls the driver crate) via
  `[[bin]] required-features`. They mirror `reference_sidecar`: plug the real
  compiled driver into `sidecar::serve`. `check-tauri-binary-target.mjs` now
  ignores feature-gated bins, so the default build still exposes exactly one
  `tabler` binary.
- Verified: lean `cargo check` / `clippy --lib -D warnings` / test build green;
  `redis_sidecar` compiles (`cargo check --features redis-sidecar --bin redis_sidecar`);
  registry + engine-gate vitest and `tsc` green; `check:tauri-target` green.

## 7. Native driver plugins: packaging and install

A `plugin_native` engine becomes usable in a lean build once its
`driver-sidecar-v1` plugin is installed. Install happens in-app from the **Plugin
Manager** (`AppPluginManagerModal`): either **Install plugin** (pick a bundle
folder on disk -> `install_plugin_bundle`) or the **Official registry** ->
**Install** (`install_registry_plugin`, from the bundled `plugin-registry.json`).
The connection picker then shows the engine as connectable
(`isNativeEngineConnectable` = compiled-in OR verified sidecar installed) and
routes connects through `connect_native_sidecar`, which spawns the per-platform
binary at `bin/<os>-<arch>/<driver_id>[.exe]` inside the verified bundle.

Remaining (release pipeline, not committed): the plugin bundles currently ship
the manifest only (`assets: []`), so a freshly installed native plugin reports
"no sidecar binary for this platform" until its binary is attached. To finish the
download-and-connect loop, per OS/arch:
1. `cargo build --release --bin <engine>_sidecar --features <engine>-sidecar`.
2. Place the binary at `plugins/<engine>-driver/bin/<os>-<arch>/<driver_id>[.exe]`.
3. Re-run `node scripts/build-plugin-registry.mjs` (it hashes the binary into the
   bundle digest and publishes a download asset per file), and host the assets at
   `PLUGIN_ASSET_BASE_URL`.
