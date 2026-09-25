# Security Policy

## Supported versions

TableR is in pre-1.0 development. Only the **latest release** on the
[releases page](https://github.com/minhe51805/TabLer/releases) receives
security fixes — there is no backport line. If you are on an older build,
upgrade first and re-check the issue there.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a vulnerability

**Do not open a public issue.** Use one of:

- **GitHub Security Advisories** (preferred):
  [Report a vulnerability](https://github.com/minhe51805/TabLer/security/advisories/new)
  — a private channel where we can coordinate a fix before disclosure.
- If advisories are unavailable, start a private thread in
  [Discussions → General](https://github.com/minhe51805/TabLer/discussions)
  asking for a maintainer contact.

### What to include

- Affected version (the titlebar label, e.g. `v0.1.6b`) and OS
- A minimal reproduction: what an attacker or malformed input can trigger
- The component touched — SQL execution path, connection storage, agent
  tools, updater, file dialogs, …
- Whether the impact is local-only (data corruption, credential exposure)
  or remote (code execution via a malicious server/payload)

### What to expect

- **Acknowledgement** within 3 days.
- **Assessment + plan** within 1 week — severity, scope, and whether a fix
  or a workaround ships first.
- **Credit** in the release notes unless you ask otherwise.

### Out of scope

- Issues requiring physical access or a compromised host OS.
- Vulnerabilities in third-party database drivers — report those upstream.
- The update channel: `latest.json` is unsigned when
  `TAURI_SIGNING_PRIVATE_KEY` is not configured (see `docs/RELEASE_SIGNING.md`);
  that is a known pre-1.0 gap, not a reportable bug.
