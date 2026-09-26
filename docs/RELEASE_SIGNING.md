# Release signing & auto-update

The in-app updater needs two things on every release:

1. `latest.json` — the manifest pointing at the new installers, published at
   `releases/latest/download/latest.json`.
2. A minisign signature for each installer, produced only when the signing
   private key is present in CI.

Without the key, the release job skips updater artifacts entirely — the endpoint
404s and the app silently never offers an update.

## One-time setup

```bash
# Generate the keypair once, locally.
npx tauri signer generate -w ~/.tauri/tabler.key
# → ~/.tauri/tabler.key      (private — keep secret, back it up)
# → ~/.tauri/tabler.key.pub  (public — goes into tauri.conf.json)
```

Then:

1. **GitHub → repo → Settings → Secrets and variables → Actions**, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — full contents of `tabler.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase, if you set one
2. **`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`** — contents of
   `tabler.key.pub`. Already set for the current keypair.

The next release automatically emits signed installers + `latest.json`;
`scripts/validate-updater-manifest.mjs` verifies the manifest matches the tag.

## Rules

- **Never rotate the key casually.** The pubkey is baked into every shipped
  installer; a new keypair means old installs can never verify an update. Rotate
  only if the private key leaked, and call it out in the release notes.
- **Lost private key = dead updater.** There is no recovery; generate a new
  pair, bump the pubkey, and tell users to reinstall once.
- The private key lives only in the CI secret and your local backup — never in
  the repo, never in logs.

## Key history

- **2026-09-24 — rotated.** The private key for the previous pubkey
  (`79A12FBBA30111FA`) was lost; `latest.json` had never been emitted, so no
  shipped build could verify updates anyway. Pubkey `5F9E9AC9B58C6059` was
  set but its passphrase was lost before any release shipped — see below.
- **2026-09-27 — rotated again.** The Sep-24 private key was passphrase-
  encrypted and its passphrase never made it into CI
  (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` was unset), so the v0.1.7 bundling
  died on "incorrect updater private key password". Regenerated with a known
  passphrase; new pubkey `F4F4BB9809F2CE0D` is in `tauri.conf.json`. Both
  secrets must be set: `TAURI_SIGNING_PRIVATE_KEY` (file contents) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the passphrase).
