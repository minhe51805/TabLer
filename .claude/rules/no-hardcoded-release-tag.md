---
name: no-hardcoded-release-tag
enabled: true
event: write
pattern: \b0\.1\.[0-9]+[a-z]*["'`]
action: warn
---

A version literal appears in a file that is not a version manifest.

Version drift between `package.json` (`releaseLabel`), `src-tauri/Cargo.toml` (`version`)
and the release tag is the defect that broke the `v0.1.6a` release: the bundle version
stays `0.1.6` while the tag, and therefore the label users see, is `v0.1.6a`.
`scripts/check-release-contract.mjs` exists to catch exactly this.

Read the version at runtime instead of writing it into prose, a test fixture or a
script. If a literal really is required (a changelog entry, a migration guard), make sure
the contract check still passes:

    RELEASE_TAG=<tag> node scripts/check-release-contract.mjs
