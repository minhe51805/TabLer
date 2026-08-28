// Persistent per-database consent for AI live data reads.
//
// Scope = connectionId + database (deliberately NOT the AI session): once a
// user allows live data reads for a database, later app launches and later
// AI sessions on the same database skip the consent prompt. The prompt only
// re-appears when the user targets a database without a stored approval or
// explicitly toggles the permission off for the current one.

const AI_DATA_READ_APPROVALS_STORAGE_KEY = "tabler.ai.dataReadApprovals.v1";

type DataReadApprovals = Record<string, number>; // scope -> approvedAt (epoch ms)

function loadDataReadApprovals(): DataReadApprovals {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(AI_DATA_READ_APPROVALS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number"
    );
    return Object.fromEntries(entries);
  } catch {
    // Corrupt or unavailable storage: treat as no approvals, never block.
    return {};
  }
}

function saveDataReadApprovals(approvals: DataReadApprovals): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      AI_DATA_READ_APPROVALS_STORAGE_KEY,
      JSON.stringify(approvals)
    );
  } catch {
    // Ignore storage write failures (private mode, quota, etc.).
  }
}

export function dataReadScopeKey(
  connectionId: string | null | undefined,
  database: string | null | undefined
): string {
  return `${connectionId || "no-connection"}:${database || "no-database"}`;
}

export function isDataReadApproved(
  connectionId: string | null | undefined,
  database: string | null | undefined
): boolean {
  return Boolean(loadDataReadApprovals()[dataReadScopeKey(connectionId, database)]);
}

export function approveDataRead(
  connectionId: string | null | undefined,
  database: string | null | undefined
): void {
  const approvals = loadDataReadApprovals();
  approvals[dataReadScopeKey(connectionId, database)] = Date.now();
  saveDataReadApprovals(approvals);
}

export function revokeDataRead(
  connectionId: string | null | undefined,
  database: string | null | undefined
): void {
  const approvals = loadDataReadApprovals();
  const scope = dataReadScopeKey(connectionId, database);
  if (!(scope in approvals)) return;
  delete approvals[scope];
  saveDataReadApprovals(approvals);
}