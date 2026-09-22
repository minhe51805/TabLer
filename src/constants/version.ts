import pkg from "../../package.json";

// The user-facing label (releaseLabel) is what users see — e.g. "0.1.6b" —
// while the Cargo/bundle version stays SemVer ("0.1.6"). Deriving it from
// package.json keeps the launcher topbar, About modal, and workspace footer
// in lockstep with the release contract instead of drifting on a hardcoded
// string (the drift that broke the v0.1.6a release).
export const APP_VERSION: string = pkg.releaseLabel ?? pkg.version;
