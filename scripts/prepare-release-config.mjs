import { writeFileSync } from "node:fs";

/**
 * Generates `src-tauri/tauri.runtime-release.conf.json` for local release
 * builds, mirroring the CI "Prepare runtime release configuration" step.
 *
 * `tauri.release.conf.json` requests updater artifacts; producing them needs
 * the updater signing private key. Without it `tauri build` fails deep in the
 * bundler with "public key found, but no private key" — this script turns
 * that into a clear, actionable message and builds without updater artifacts
 * (same as CI does when the secret is absent).
 */

const RUNTIME_CONF = "src-tauri/tauri.runtime-release.conf.json";
const hasSigningKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());

writeFileSync(
  RUNTIME_CONF,
  `${JSON.stringify({ bundle: { createUpdaterArtifacts: hasSigningKey } })}\n`,
);

if (hasSigningKey) {
  console.log(
    `[build:release] TAURI_SIGNING_PRIVATE_KEY detected — updater artifacts enabled (wrote ${RUNTIME_CONF}).`,
  );
} else {
  console.warn(
    `[build:release] TAURI_SIGNING_PRIVATE_KEY is not set — building WITHOUT updater artifacts.\n` +
      `  The app will bundle fine, but it cannot auto-update and no latest.json/.sig files are produced.\n` +
      `  To build updater artifacts: generate a keypair with 'npx tauri signer generate', set\n` +
      `  TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD if used), then re-run.\n` +
      `  (wrote ${RUNTIME_CONF} with createUpdaterArtifacts=false)`,
  );
}
