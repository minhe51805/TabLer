import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DatabaseZap, ShieldAlert, TriangleAlert } from "lucide-react";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import { setAISqlConfirmHostMounted } from "./ai-sql-confirm";

interface AISqlConfirmRequest {
  id: number;
  requirement: "mutation" | "high-risk";
  statements: string[];
}

interface AISqlConfirmResponse {
  id: number;
  approved: boolean;
}

const CONFIRM_REQUEST_EVENT = "ai-sql-confirm-request";
const CONFIRM_RESPONSE_EVENT = "ai-sql-confirm-response";
const MAX_PREVIEW_CHARS = 800;


interface AISqlConfirmDialogProps {
  copy: AIWorkspaceCopy["composer"];
}

/**
 * Host for AI SQL run approvals. Listens for confirm requests dispatched by
 * `requestAISqlConfirmation` and renders a themed modal with the full SQL
 * preview — replacing the old native window.confirm for the AI SQL runner.
 */
export function AISqlConfirmDialog({ copy }: AISqlConfirmDialogProps) {
  const [request, setRequest] = useState<AISqlConfirmRequest | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setAISqlConfirmHostMounted(true);
    const handleRequest = (event: Event) => {
      setRequest((event as CustomEvent<AISqlConfirmRequest>).detail);
    };
    window.addEventListener(CONFIRM_REQUEST_EVENT, handleRequest);
    return () => {
      mountedRef.current = false;
      setAISqlConfirmHostMounted(false);
      window.removeEventListener(CONFIRM_REQUEST_EVENT, handleRequest);
    };
  }, []);

  const respond = (approved: boolean) => {
    if (!request) return;
    window.dispatchEvent(
      new CustomEvent<AISqlConfirmResponse>(CONFIRM_RESPONSE_EVENT, {
        detail: { id: request.id, approved },
      }),
    );
    setRequest(null);
  };

  // Panel closed while a run awaited approval: reject it so nothing executes.
  useEffect(() => {
    if (!request) return;
    return () => {
      if (mountedRef.current) return;
      window.dispatchEvent(
        new CustomEvent<AISqlConfirmResponse>(CONFIRM_RESPONSE_EVENT, {
          detail: { id: request.id, approved: false },
        }),
      );
    };
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") respond(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return null;

  const isHighRisk = request.requirement === "high-risk";
  const previewSql = request.statements.join(";\n\n");
  const truncatedPreview = previewSql.length > MAX_PREVIEW_CHARS
    ? `${previewSql.slice(0, MAX_PREVIEW_CHARS)}…`
    : previewSql;
  const batchLabel = copy.sqlConfirmBatchLabel.replace(
    "{count}",
    String(request.statements.length),
  );

  const dialog = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => respond(false)}
    >
      <div
        className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              isHighRisk ? "bg-red-500/10 text-red-500" : "bg-amber-500/10 text-amber-500"
            }`}
          >
            {isHighRisk
              ? <TriangleAlert className="h-5 w-5" />
              : <DatabaseZap className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              {isHighRisk ? copy.sqlConfirmHighRiskTitle : copy.sqlConfirmWriteTitle}
            </h2>
            {request.statements.length > 1 && (
              <p className="text-xs text-[var(--text-muted)]">{batchLabel}</p>
            )}
          </div>
          {isHighRisk && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-500">
              <ShieldAlert className="h-3 w-3" />
              HIGH RISK
            </span>
          )}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {isHighRisk ? copy.sqlConfirmHighRiskBody : copy.sqlConfirmWriteBody}
          </p>
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
              {copy.sqlConfirmPreviewLabel}
            </p>
            <div className="max-h-56 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs text-[var(--text-secondary)]">
                {truncatedPreview}
              </pre>
            </div>
            {previewSql.length > MAX_PREVIEW_CHARS && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                ({previewSql.length} chars)
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-6 py-4">
          <button
            type="button"
            onClick={() => respond(false)}
            className="btn btn-secondary"
            autoFocus
          >
            {copy.sqlConfirmCancelLabel}
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            className={`btn btn-primary ${isHighRisk ? "!bg-red-600 hover:!bg-red-500" : ""}`}
          >
            {copy.sqlConfirmRunLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
