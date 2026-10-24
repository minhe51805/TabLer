export interface InsecureTlsWarning {
  insecure: true;
  reason: string;
}

export type ConnectionTlsParams = object | string;

type TlsValue = string | number | boolean | null | undefined;

function normalizeKey(key: string) {
  return key.trim().toLowerCase().replace(/_/g, "-");
}

function normalizeValue(value: TlsValue) {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function isTrue(value: TlsValue) {
  const normalized = normalizeValue(value);
  return normalized === true || normalized === 1 || normalized === "1" || normalized === "true";
}

function isFalse(value: TlsValue) {
  const normalized = normalizeValue(value);
  return (
    normalized === false ||
    normalized === 0 ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "disabled"
  );
}

function parseConnectionOptions(text: string) {
  const values = new Map<string, TlsValue>();
  const assign = (key: string, value: string) => values.set(normalizeKey(key), value);
  try {
    const url = new URL(text);
    url.searchParams.forEach((value, key) => assign(key, value));
  } catch {
    const query = text.split("?")[1]?.split("#", 1)[0];
    if (query) new URLSearchParams(query).forEach((value, key) => assign(key, value));
  }
  for (const part of text.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) assign(part.slice(0, separator), part.slice(separator + 1));
  }
  return values;
}

export function detectInsecureTls(params: ConnectionTlsParams): InsecureTlsWarning | null {
  const source = (typeof params === "string" ? { connectionUrl: params } : params) as Record<
    string,
    unknown
  >;
  const containers = [source, source.additional_fields, source.additionalFields].filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
  const connectionOptions = [
    source.connectionUrl,
    source.connection_url,
    source.connectionString,
    source.connection_string,
    source.url,
    source.host,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => [...parseConnectionOptions(value)]);

  const read = (...keys: string[]): TlsValue => {
    for (const key of keys) {
      const wanted = normalizeKey(key);
      for (const container of containers) {
        for (const [candidate, value] of Object.entries(container)) {
          if (normalizeKey(candidate) === wanted) return value as TlsValue;
        }
      }
      const option = connectionOptions.find(([candidate]) => candidate === wanted);
      if (option) return option[1];
    }
    return undefined;
  };

  if (isTrue(read("trustServerCertificate", "trust-server-certificate"))) {
    return {
      insecure: true,
      reason: "The server certificate is trusted without verification.",
    };
  }

  const sslMode = normalizeValue(read("sslmode", "ssl-mode"));
  if (sslMode === "disable" || sslMode === "disabled") {
    return { insecure: true, reason: "TLS is disabled for this connection." };
  }

  if (
    isFalse(read("sslverify", "ssl-verify")) ||
    isFalse(read("ssl_cert_verify", "ssl-cert-verify"))
  ) {
    return { insecure: true, reason: "TLS certificate verification is disabled." };
  }

  if (
    typeof sslMode === "string" &&
    ["require", "required", "verify-ca", "verify-full", "verify-identity"].includes(
      sslMode.replace(/_/g, "-"),
    )
  ) {
    return null;
  }

  if (isFalse(read("useSsl", "use_ssl"))) {
    return { insecure: true, reason: "TLS is disabled for this connection profile." };
  }

  return null;
}
