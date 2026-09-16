import { describe, expect, it } from "vitest";

import {
  MAX_POOL_MAX_CONNECTIONS,
  MIN_POOL_MAX_CONNECTIONS,
  POOL_MAX_CONNECTIONS_ALIAS_KEY,
  POOL_MAX_CONNECTIONS_DEFAULT,
  POOL_MAX_CONNECTIONS_KEY,
  clampPoolMaxConnections,
  engineSupportsPoolSizing,
  getPoolMaxConnections,
} from "@/components/ConnectionForm/connection-pool";

describe("connection-pool typed knob", () => {
  it("mirrors the backend bounds", () => {
    expect(POOL_MAX_CONNECTIONS_DEFAULT).toBe(8);
    expect(MIN_POOL_MAX_CONNECTIONS).toBe(1);
    expect(MAX_POOL_MAX_CONNECTIONS).toBe(64);
  });

  it("only exposes the knob for pooled server engines", () => {
    expect(engineSupportsPoolSizing("postgresql")).toBe(true);
    expect(engineSupportsPoolSizing("mysql")).toBe(true);
    expect(engineSupportsPoolSizing("mariadb")).toBe(true);
    expect(engineSupportsPoolSizing("sqlite")).toBe(false);
    expect(engineSupportsPoolSizing("mssql")).toBe(false);
    expect(engineSupportsPoolSizing(undefined)).toBe(false);
  });

  it("clamps positive values and falls back to the default otherwise", () => {
    expect(clampPoolMaxConnections(16)).toBe(16);
    expect(clampPoolMaxConnections(0)).toBe(POOL_MAX_CONNECTIONS_DEFAULT);
    expect(clampPoolMaxConnections(-5)).toBe(POOL_MAX_CONNECTIONS_DEFAULT);
    expect(clampPoolMaxConnections(1000)).toBe(MAX_POOL_MAX_CONNECTIONS);
    // A positive fraction floors below the floor, then clamps up to MIN.
    expect(clampPoolMaxConnections(0.9)).toBe(MIN_POOL_MAX_CONNECTIONS);
    expect(clampPoolMaxConnections(9.9)).toBe(9);
    expect(clampPoolMaxConnections(Number.NaN)).toBe(POOL_MAX_CONNECTIONS_DEFAULT);
  });

  it("reads the override from additional_fields, treating blank/invalid as unset", () => {
    expect(getPoolMaxConnections(undefined)).toBeUndefined();
    expect(getPoolMaxConnections({})).toBeUndefined();
    expect(getPoolMaxConnections({ [POOL_MAX_CONNECTIONS_KEY]: "" })).toBeUndefined();
    expect(getPoolMaxConnections({ [POOL_MAX_CONNECTIONS_KEY]: "   " })).toBeUndefined();
    expect(getPoolMaxConnections({ [POOL_MAX_CONNECTIONS_KEY]: "abc" })).toBeUndefined();
    expect(getPoolMaxConnections({ [POOL_MAX_CONNECTIONS_KEY]: "0" })).toBeUndefined();
    expect(getPoolMaxConnections({ [POOL_MAX_CONNECTIONS_KEY]: "12" })).toBe(12);
  });

  it("accepts the legacy camelCase alias", () => {
    expect(getPoolMaxConnections({ [POOL_MAX_CONNECTIONS_ALIAS_KEY]: "20" })).toBe(20);
  });
});
