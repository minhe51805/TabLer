import { describe, expect, it } from "vitest";
import { detectInsecureTls } from "@/utils/connection-tls";

describe("detectInsecureTls", () => {
  it.each([
    [{ sslmode: "disable" }, "disable"],
    [{ "ssl-mode": "DISABLED" }, "disabled"],
    [{ use_ssl: false }, "use_ssl=false"],
    [{ trustServerCertificate: true }, "trust-all"],
    [{ additional_fields: { sslverify: "0" } }, "sslverify=0"],
    [{ additionalFields: { ssl_cert_verify: "false" } }, "ssl_cert_verify=false"],
    ["postgresql://user:pass@example.test/db?sslmode=disable", "URL sslmode"],
    ["mongodb://example.test/db?ssl_cert_verify=false", "URL certificate verification"],
    ["Server=example.test;TrustServerCertificate=true;", "ADO trust-all"],
  ])("flags an insecure profile: %s", (params, _label) => {
    expect(detectInsecureTls(params)).toEqual(
      expect.objectContaining({ insecure: true, reason: expect.any(String) }),
    );
  });

  it.each([
    [{ "ssl-mode": "VERIFY_IDENTITY" }, "verify identity"],
    [{ ssl_mode: "verify_full", use_ssl: true }, "verify full"],
    [{ trustServerCertificate: false, ssl_mode: "require" }, "required TLS"],
    [{}, "no insecure options"],
  ])("returns null for a secure or unspecified profile: %s", (params, _label) => {
    expect(detectInsecureTls(params)).toBeNull();
  });
});
