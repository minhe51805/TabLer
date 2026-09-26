import { afterEach, describe, expect, it } from "vitest";

import {
  extractEnvVarNames,
  hasEnvVar,
  resolveEnvVars,
  resolveFieldWithMeta,
} from "@/utils/env-resolve";

// getEnvValue precedence: import.meta.env["VITE_" + name] →
// import.meta.env[name] → window["ENV_" + name]. import.meta.env is a
// per-module snapshot taken before tests run, so injected VITE_/bare keys
// cannot reach the module — the tests below exercise the two dynamic seams:
// a real bare env key (MODE, always present under vitest) vs window.ENV_.

const win = window as unknown as Record<string, unknown>;

function setWindowEnv(name: string, value: string | undefined) {
  if (value === undefined) delete win[`ENV_${name}`];
  else win[`ENV_${name}`] = value;
}

afterEach(() => {
  for (const name of ["TABLER_TEST_A", "TABLER_TEST_MISSING", "MODE"]) {
    setWindowEnv(name, undefined);
  }
});

describe("resolveEnvVars precedence", () => {
  it("prefers a bare env value over window.ENV_", () => {
    // MODE is present in import.meta.env under vitest ("test") and VITE_MODE
    // is not — this exercises the bare-env branch beating the window seam.
    const bareMode = (import.meta.env as Record<string, string | undefined>).MODE;
    const viteMode = (import.meta.env as Record<string, string | undefined>).VITE_MODE;
    expect(bareMode).toBeTruthy();
    expect(viteMode).toBeUndefined();

    setWindowEnv("MODE", "window-mode");
    expect(resolveEnvVars("$MODE")).toBe(bareMode);
  });

  it("uses window.ENV_ when no env entry exists", () => {
    setWindowEnv("TABLER_TEST_A", "window-value");

    expect(resolveEnvVars("$TABLER_TEST_A")).toBe("window-value");
    expect(resolveEnvVars("${TABLER_TEST_A}")).toBe("window-value");
    expect(resolveEnvVars("%TABLER_TEST_A%")).toBe("window-value");
    expect(resolveEnvVars("host is $TABLER_TEST_A.")).toBe("host is window-value.");
  });

  it("leaves unresolved references literal instead of dropping them", () => {
    expect(resolveEnvVars("$TABLER_TEST_MISSING")).toBe("$TABLER_TEST_MISSING");
    expect(resolveEnvVars("${TABLER_TEST_MISSING}")).toBe("${TABLER_TEST_MISSING}");
    expect(resolveEnvVars("%TABLER_TEST_MISSING%")).toBe("%TABLER_TEST_MISSING%");
    // Resolved and unresolved refs can coexist in one string.
    setWindowEnv("TABLER_TEST_A", "set");
    expect(resolveEnvVars("$TABLER_TEST_A and $TABLER_TEST_MISSING")).toBe(
      "set and $TABLER_TEST_MISSING",
    );
  });
});

describe("hasEnvVar / extractEnvVarNames", () => {
  it("detects every supported syntax", () => {
    expect(hasEnvVar("$A")).toBe(true);
    expect(hasEnvVar("${A}")).toBe(true);
    expect(hasEnvVar("%A%")).toBe(true);
    expect(hasEnvVar("plain")).toBe(false);
  });

  it("extracts and dedupes names across $VAR, ${VAR}, and %VAR% syntaxes", () => {
    const names = extractEnvVarNames("$DB_HOST -- ${DB_HOST} -- %DB_HOST% -- $DB_PASS -- %OTHER%");
    expect(names).toEqual(["DB_HOST", "DB_PASS", "OTHER"]);
  });

  it("returns an empty list for strings without references", () => {
    expect(extractEnvVarNames("no vars here")).toEqual([]);
    expect(extractEnvVarNames("")).toEqual([]);
  });
});

describe("resolveFieldWithMeta", () => {
  it("marks unset variables in the tooltip instead of inventing values", () => {
    setWindowEnv("TABLER_TEST_A", "window-a");

    const meta = resolveFieldWithMeta("$TABLER_TEST_A:$TABLER_TEST_MISSING");
    expect(meta.hasEnvVar).toBe(true);
    expect(meta.envNames).toEqual(["TABLER_TEST_A", "TABLER_TEST_MISSING"]);
    expect(meta.resolved).toBe("window-a:$TABLER_TEST_MISSING");
    expect(meta.tooltipText).toContain("TABLER_TEST_A = window-a");
    expect(meta.tooltipText).toContain("TABLER_TEST_MISSING = (not set)");
  });
});
