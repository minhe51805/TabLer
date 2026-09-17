---
name: no-sidecar-in-src-bin
enabled: true
event: write
pattern: (^|\n)[^\n]*src-tauri/src/bin/
action: block
---

Do not add native sidecar binaries to `src-tauri/src/bin/`.

The Tauri CLI pinned in `package-lock.json` (2.10.x) makes the bundler pick up **every**
file in `src-tauri/src/bin/` as a bundle binary and ignores `required-features`. That
makes NSIS/MSI/dmg/AppImage builds fail with "Failed to copy binary … does not exist"
(two release attempts were lost to this, see `AGENTS.md`).

Sidecars live in `src-tauri/src/sidecar_bins/`, and each keeps its `required-features`
entry in `src-tauri/Cargo.toml`. Building one still works the same way:

    cargo build --bin redis_sidecar --features redis-sidecar --manifest-path src-tauri/Cargo.toml

Moving them back is only correct after `@tauri-apps/cli` is bumped past the fix
(Tauri CLI 2.11.4, upstream #15427) — and the bump must be verified on all three
platforms before the move.
