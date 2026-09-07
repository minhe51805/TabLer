import { open } from "@tauri-apps/plugin-dialog";
import type { PostgresFieldsProps } from "./engine-fields-types";
import { SSL_MODE_LABELS, sslModeRequiresCertificates, type SSLMode } from "../../../types/ssl-modes";

export function PostgresFields({
  formData,
  suggestedUsernamePlaceholder,
  strings,
  onFieldChange,
}: PostgresFieldsProps) {
  const sslMode: SSLMode = (formData.ssl_mode as SSLMode) ?? (formData.use_ssl ? "require" : "disable");
  const showCertFields = sslModeRequiresCertificates(sslMode);

  const handleSSLModeChange = (mode: SSLMode) => {
    onFieldChange("ssl_mode", mode);
    // Mirror use_ssl for backward compatibility
    onFieldChange("use_ssl", mode !== "disable");
  };

  const pickFile = async (
    field: "ssl_ca_cert_path" | "ssl_client_cert_path" | "ssl_client_key_path",
  ) => {
    const result = await open({
      multiple: false,
      filters: [
        { name: "Certificate", extensions: ["pem", "crt", "cer", "p12", "pfx"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result) {
      onFieldChange(field, result as any);
    }
  };

  return (
    <>
      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.host}</label>
        <input
          type="text"
          value={formData.host || ""}
          onChange={(e) => onFieldChange("host", e.target.value)}
          placeholder="127.0.0.1"
          className="input h-11"
        />
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.port}</label>
        <input
          type="number"
          value={formData.port || ""}
          onChange={(e) => onFieldChange("port", parseInt(e.target.value) || undefined)}
          placeholder="5432"
          className="input h-11"
        />
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.username}</label>
        <input
          type="text"
          value={formData.username || ""}
          onChange={(e) => onFieldChange("username", e.target.value)}
          placeholder={suggestedUsernamePlaceholder}
          className="input h-11"
        />
      </div>

      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">{strings.databaseOptional} <span className="opacity-60">({strings.optional})</span></label>
        <input
          type="text"
          value={formData.database || ""}
          onChange={(e) => onFieldChange("database", e.target.value)}
          placeholder="postgres"
          className="input h-11"
        />
      </div>

      {/* SSL Mode */}
      <div className="connection-form-field">
        <label className="form-label uppercase tracking-wide">SSL / TLS</label>
        <div className="ssl-mode-segmented">
          {(Object.keys(SSL_MODE_LABELS) as SSLMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`ssl-mode-btn ${sslMode === mode ? "active" : ""}`}
              onClick={() => handleSSLModeChange(mode)}
              title={SSL_MODE_LABELS[mode].description}
            >
              {SSL_MODE_LABELS[mode].short}
            </button>
          ))}
        </div>
      </div>

      {/* Certificate fields — shown only when mode >= verify_ca */}
      {showCertFields && (
        <>
          <div className="connection-form-field">
            <label className="form-label uppercase tracking-wide">CA Certificate</label>
            <div className="ssl-file-input-row">
              <input
                type="text"
                className="input h-11 flex-1"
                value={formData.ssl_ca_cert_path || ""}
                onChange={(e) => onFieldChange("ssl_ca_cert_path", e.target.value)}
                placeholder="/etc/ssl/certs/ca-cert.pem"
                readOnly
              />
              <button
                type="button"
                className="btn btn-secondary h-11"
                onClick={() => pickFile("ssl_ca_cert_path")}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="connection-form-field">
            <label className="form-label uppercase tracking-wide">Client Certificate</label>
            <div className="ssl-file-input-row">
              <input
                type="text"
                className="input h-11 flex-1"
                value={formData.ssl_client_cert_path || ""}
                onChange={(e) => onFieldChange("ssl_client_cert_path", e.target.value)}
                placeholder="/etc/ssl/client/client-cert.pem"
                readOnly
              />
              <button
                type="button"
                className="btn btn-secondary h-11"
                onClick={() => pickFile("ssl_client_cert_path")}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="connection-form-field">
            <label className="form-label uppercase tracking-wide">Client Key</label>
            <div className="ssl-file-input-row">
              <input
                type="text"
                className="input h-11 flex-1"
                value={formData.ssl_client_key_path || ""}
                onChange={(e) => onFieldChange("ssl_client_key_path", e.target.value)}
                placeholder="/etc/ssl/client/client-key.pem"
                readOnly
              />
              <button
                type="button"
                className="btn btn-secondary h-11"
                onClick={() => pickFile("ssl_client_key_path")}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="connection-form-field">
            <label className="ssl-checkbox-label">
              <input
                type="checkbox"
                checked={formData.ssl_skip_host_verification || false}
                onChange={(e) => onFieldChange("ssl_skip_host_verification", e.target.checked)}
              />
              Skip hostname verification
            </label>
          </div>
        </>
      )}
    </>
  );
}