/**
 * Pure helpers for the connection form: preset SQL bootstrap,
 * draft config creation and local-host detection.
 */

import { getDatabaseEngine } from "./engine-registry";
import type { ConnectionConfig } from "../../types";
import type { DatabaseType } from "../../types/database";

export type BootstrapPreset = "none" | "starter_core" | "starter_commerce";

const COLORS = [
  "#f38ba8", "#c49a78", "#b8ab86", "#7fb07f",
  "#6a8fc8", "#9b86c9", "#c49fbf", "#7fb7b7",
];

export function getBootstrapPresetSql(preset: BootstrapPreset, dbType: DatabaseType) {
  const timestampType = dbType === "mysql" || dbType === "mariadb" ? "DATETIME" : "TIMESTAMP";

  if (preset === "starter_core") {
    return [
      "CREATE TABLE IF NOT EXISTS users (",
      "  id BIGINT PRIMARY KEY,",
      "  email VARCHAR(255) NOT NULL,",
      "  full_name VARCHAR(255),",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS audit_log (",
      "  id BIGINT PRIMARY KEY,",
      "  entity_type VARCHAR(80) NOT NULL,",
      "  entity_id BIGINT,",
      "  action VARCHAR(80) NOT NULL,",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
    ].join("\n");
  }

  if (preset === "starter_commerce") {
    return [
      "CREATE TABLE IF NOT EXISTS customers (",
      "  id BIGINT PRIMARY KEY,",
      "  email VARCHAR(255) NOT NULL,",
      "  full_name VARCHAR(255),",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS products (",
      "  id BIGINT PRIMARY KEY,",
      "  name VARCHAR(255) NOT NULL,",
      "  sku VARCHAR(120),",
      "  price DECIMAL(12,2) NOT NULL",
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS orders (",
      "  id BIGINT PRIMARY KEY,",
      "  customer_id BIGINT NOT NULL,",
      "  status VARCHAR(80) NOT NULL,",
      `  created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP`,
      ");",
    ].join("\n");
  }

  return "";
}

export function isLocalHost(host?: string) {
  const normalized = (host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

export function createConnectionDraft(dbType: DatabaseType): ConnectionConfig {
  const engine = getDatabaseEngine(dbType);

  return {
    id: crypto.randomUUID(),
    name: "",
    db_type: dbType,
    host: engine?.connectionMode === "network" ? (engine.defaultHost ?? "") : "",
    port: engine?.defaultPort,
    username: "",
    database: "",
    file_path: "",
    use_ssl: false,
    color: COLORS[0],
    additional_fields: {},
  };
}
