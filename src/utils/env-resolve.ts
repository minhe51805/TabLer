/**
 * Environment variable resolution utilities for connection fields.
 * Supports $VAR, ${VAR}, and %VAR% syntax.
 */

/** Resolve all env var references in a string.
 * Checks VITE_ prefix first (frontend Vite env), then falls back to window.ENV_
 * which can be populated from the Rust backend via IPC.
 *
 * Syntax:
 *   $VAR_NAME       → single token
 *   ${VAR_NAME}     → braced
 *   %VAR_NAME%      → Windows-style
 */
export function resolveEnvVars(value: string): string {
  if (!value || typeof value !== "string") return value;

  return value.replace(/\$(\w+)|\${(\w+)}|%(\w+)%/g, (match, bare, braced, win) => {
    const name = bare || braced || win;
    const envValue = getEnvValue(name);
    return envValue !== undefined ? envValue : match;
  });
}

/** Check if a string contains any env var references */
export function hasEnvVar(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return /\$(\w+)|\${(\w+)}|%(\w+)%/.test(value);
}

/** Extract all env var names from a string */
export function extractEnvVarNames(value: string): string[] {
  if (!value || typeof value !== "string") return [];
  const names: string[] = [];
  const seen = new Set<string>();
  value.replace(/\$(\w+)|\${(\w+)}|%(\w+)%/g, (_, bare, braced, win) => {
    const name = bare || braced || win;
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    return "";
  });
  return names;
}

/** Get env var value — checks VITE_ prefix, then window.ENV_ fallback */
function getEnvValue(name: string): string | undefined {
  // 1. Vite env (VITE_ prefix)
  const viteKey = `VITE_${name}`;
  const viteVal = (import.meta as { env?: Record<string, string> }).env?.[viteKey];
  if (viteVal !== undefined) return viteVal;

  // 2. Vite env (without prefix — direct access)
  const directVal = (import.meta as { env?: Record<string, string> }).env?.[name];
  if (directVal !== undefined) return directVal;

  // 3. Backend-provided env (window.ENV_)
  const backendVal = (window as unknown as Record<string, unknown>)[`ENV_${name}`];
  if (typeof backendVal === "string") return backendVal;

  return undefined;
}

/** Resolved value with metadata */
export interface ResolvedField {
  raw: string;
  resolved: string;
  hasEnvVar: boolean;
  envNames: string[];
  /** Human-readable tooltip text */
  tooltipText: string;
}

/** Resolve env vars for a connection field, returning metadata */
export function resolveFieldWithMeta(value: string): ResolvedField {
  const hasEnv = hasEnvVar(value);
  const names = extractEnvVarNames(value);
  const resolved = resolveEnvVars(value);

  let tooltipText = "";
  if (hasEnv && names.length > 0) {
    tooltipText = names
      .map((n) => {
        const val = getEnvValue(n);
        return val !== undefined ? `${n} = ${val}` : `${n} = (not set)`;
      })
      .join("\n");
  }

  return {
    raw: value,
    resolved,
    hasEnvVar: hasEnv,
    envNames: names,
    tooltipText,
  };
}
