import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock, X } from "lucide-react";
import { useI18n, type AppLanguage } from "../i18n";
import { useExportEncryptStore } from "../stores/confirmStore";

const MIN_PASSWORD_LEN = 10;

interface ExportEncryptCopy {
  title: string;
  encrypt: string;
  note: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  errorPasswordShort: string;
  exportButton: string;
  cancel: string;
}

const COPY: Record<AppLanguage, ExportEncryptCopy> = {
  en: {
    title: "Export options",
    encrypt: "Encrypt export (AES-256-GCM)",
    note: "The file is written as <name>.texp",
    passwordLabel: "Encryption password",
    passwordPlaceholder: "Min. 10 characters",
    errorPasswordShort: "Password must be at least 10 characters.",
    exportButton: "Export",
    cancel: "Cancel",
  },
  vi: {
    title: "Tùy chọn xuất",
    encrypt: "Mã hóa tệp xuất (AES-256-GCM)",
    note: "Tệp được ghi dưới dạng <tên>.texp",
    passwordLabel: "Mật khẩu mã hóa",
    passwordPlaceholder: "Tối thiểu 10 ký tự",
    errorPasswordShort: "Mật khẩu phải có ít nhất 10 ký tự.",
    exportButton: "Xuất",
    cancel: "Hủy",
  },
  ko: {
    title: "내보내기 옵션",
    encrypt: "내보내기 암호화 (AES-256-GCM)",
    note: "파일은 <이름>.texp로 저장됩니다",
    passwordLabel: "암호화 비밀번호",
    passwordPlaceholder: "최소 10자",
    errorPasswordShort: "비밀번호는 최소 10자여야 합니다.",
    exportButton: "내보내기",
    cancel: "취소",
  },
  tr: {
    title: "Dışa aktarma seçenekleri",
    encrypt: "Dışa aktarmayı şifrele (AES-256-GCM)",
    note: "Dosya <ad>.texp olarak yazılır",
    passwordLabel: "Şifreleme parolası",
    passwordPlaceholder: "En az 10 karakter",
    errorPasswordShort: "Parola en az 10 karakter olmalıdır.",
    exportButton: "Dışa Aktar",
    cancel: "İptal",
  },
  zh: {
    title: "导出选项",
    encrypt: "加密导出（AES-256-GCM）",
    note: "文件将保存为 <名称>.texp",
    passwordLabel: "加密密码",
    passwordPlaceholder: "至少 10 个字符",
    errorPasswordShort: "密码至少需要 10 个字符。",
    exportButton: "导出",
    cancel: "取消",
  },
};

/**
 * Global host for `requestAppExportEncryption` — rendered once inside
 * AppGlobalModals whenever an export flow asks whether the output file
 * should be encrypted. Checkbox off + Export resolves `password: null`
 * (plaintext); cancelling resolves `confirmed: false`.
 */
export function ExportEncryptDialog() {
  const { language } = useI18n();
  const pending = useExportEncryptStore((state) => state.pendingExportEncrypt);
  const respond = useExportEncryptStore((state) => state.respondExportEncrypt);
  const copy = COPY[language] ?? COPY.en;

  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Fresh state for each request; focus moves to the password box when the
  // user opts in.
  useEffect(() => {
    setEncrypt(false);
    setPassword("");
    setError(null);
  }, [pending]);

  useEffect(() => {
    if (encrypt) passwordRef.current?.focus();
  }, [encrypt]);

  const close = useCallback(
    (answer: { confirmed: boolean; password: string | null }) => respond(answer),
    [respond],
  );

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close({ confirmed: false, password: null });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, close]);

  if (!pending) return null;

  const confirm = () => {
    if (encrypt && password.length < MIN_PASSWORD_LEN) {
      setError(copy.errorPasswordShort);
      return;
    }
    close({ confirmed: true, password: encrypt ? password : null });
  };

  const dialogContent = (
    <div
      className="confirm-dialog-backdrop"
      onClick={() => close({ confirmed: false, password: null })}
    >
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <div className="confirm-dialog-header-icon">
            <Lock className="w-5 h-5" />
          </div>
          <button
            type="button"
            className="confirm-dialog-close"
            onClick={() => close({ confirmed: false, password: null })}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="confirm-dialog-body">
          <h3 className="confirm-dialog-title">{copy.title}</h3>
          <p className="confirm-dialog-message">{pending.fileLabel}</p>
          <label className="export-encrypt-toggle">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => {
                setEncrypt(e.target.checked);
                setError(null);
              }}
            />
            <span>{copy.encrypt}</span>
          </label>
          {encrypt && (
            <div className="export-encrypt-password">
              <label className="form-label uppercase tracking-wide">
                {copy.passwordLabel} <span className="text-red-400">*</span>
              </label>
              <input
                ref={passwordRef}
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
                placeholder={copy.passwordPlaceholder}
                className="input h-11"
                minLength={MIN_PASSWORD_LEN}
              />
              <p className="export-encrypt-note">{copy.note}</p>
              {error && <p className="export-encrypt-error">{error}</p>}
            </div>
          )}
        </div>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-cancel"
            onClick={() => close({ confirmed: false, password: null })}
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-confirm"
            onClick={confirm}
          >
            {copy.exportButton}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialogContent, document.body);
}
