import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  exportConnections,
  exportableToConnectionConfig,
  type ExportableConnection,
} from "@/utils/connection-export";
import type { ConnectionConfig } from "@/types";

const saved = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "conn-1",
  name: "Prod",
  db_type: "postgresql",
  host: "db.internal",
  port: 5432,
  username: "alice",
  password: "super-secret",
  database: "app",
  use_ssl: true,
  ssl_mode: "verify_full",
  ssl_ca_cert_path: "C:/certs/ca.pem",
  ssl_skip_host_verification: true,
  color: "#112233",
  additional_fields: { application_name: "tabler" },
  groupId: "group-9",
  tagId: "tag-4",
  startupCommands: "SET search_path TO app",
  query_timeout_seconds: 30,
  ...overrides,
});

describe("exportConnections", () => {
  it("never sends the saved password and maps camel fields to snake_case", async () => {
    invokeMock.mockResolvedValue("C:/exports/connections.tabler");

    const result = await exportConnections([saved()], "export-passphrase");

    expect(result).toEqual({ success: true, filePath: "C:/exports/connections.tabler" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe("export_connections_to_file");
    const [exported] = payload.connections;
    // Secrets must not leave the app in the export payload.
    expect(Object.keys(exported)).not.toContain("password");
    expect(JSON.stringify(payload.connections)).not.toContain("super-secret");
    expect(exported).toMatchObject({
      id: "conn-1",
      name: "Prod",
      db_type: "postgresql",
      host: "db.internal",
      port: 5432,
      username: "alice",
      database: "app",
      use_ssl: true,
      ssl_mode: "verify_full",
      ssl_ca_cert_path: "C:/certs/ca.pem",
      ssl_skip_host_verification: true,
      color: "#112233",
      additional_fields: { application_name: "tabler" },
      group_id: "group-9",
      tag_id: "tag-4",
      startup_commands: "SET search_path TO app",
      query_timeout_seconds: 30,
    });
    expect(payload.password).toBe("export-passphrase");
  });

  it("treats a cancelled save dialog as a clean non-error result", async () => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("No file selected."));

    const result = await exportConnections([saved()], "pw");

    expect(result).toEqual({ success: false, error: undefined });
  });

  it("surfaces real backend errors on the result", async () => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("disk full"));

    const result = await exportConnections([saved()], "pw");

    expect(result).toEqual({ success: false, error: "disk full" });
  });
});

describe("exportableToConnectionConfig", () => {
  it("re-hydrates every exported field and re-attaches the typed password", () => {
    const exported: ExportableConnection = {
      name: "Prod",
      dbType: "postgresql",
      host: "db.internal",
      port: 5432,
      username: "alice",
      database: "app",
      filePath: "/data/app.db",
      useSsl: true,
      sslMode: "verify_full",
      sslCaCertPath: "C:/certs/ca.pem",
      sslClientCertPath: "C:/certs/client.pem",
      sslClientKeyPath: "C:/certs/client.key",
      sslSkipHostVerification: true,
      color: "#112233",
      additionalFields: { application_name: "tabler" },
      groupId: "group-9",
      tagId: "tag-4",
      startupCommands: "SET search_path TO app",
      queryTimeoutSeconds: 30,
    };

    const config = exportableToConnectionConfig(exported, "typed-password");

    expect(config).toEqual({
      name: "Prod",
      db_type: "postgresql",
      host: "db.internal",
      port: 5432,
      username: "alice",
      password: "typed-password",
      database: "app",
      file_path: "/data/app.db",
      use_ssl: true,
      ssl_mode: "verify_full",
      ssl_ca_cert_path: "C:/certs/ca.pem",
      ssl_client_cert_path: "C:/certs/client.pem",
      ssl_client_key_path: "C:/certs/client.key",
      ssl_skip_host_verification: true,
      color: "#112233",
      additional_fields: { application_name: "tabler" },
      groupId: "group-9",
      tagId: "tag-4",
      startupCommands: "SET search_path TO app",
      query_timeout_seconds: 30,
    });
  });
});
