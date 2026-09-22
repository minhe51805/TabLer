/**
 * Fill dialog for `{{param}}` placeholders in a saved favorite.
 *
 * One input per unique param, prefilled with its default; a live read-only
 * preview shows the exact SQL that will run. Blocking issues (missing value,
 * invalid bool) disable Run; non-blocking issues (int param got text → quoted)
 * render as warnings.
 */

import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { ParamError, substituteParams, type SqlParam } from "../../utils/sql-params";
import { getParamFillCopy } from "./param-fill-copy";
import "./param-fill.css";

interface ParamFillDialogProps {
  sql: string;
  params: SqlParam[];
  onSubmit: (resolvedSql: string) => void;
  onCancel: () => void;
}

export function ParamFillDialog({ sql, params, onSubmit, onCancel }: ParamFillDialogProps) {
  const { language } = useI18n();
  const copy = getParamFillCopy(language);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const param of params) {
      initial[param.name] = param.default ?? "";
    }
    return initial;
  });

  const preview = useMemo(() => {
    try {
      const result = substituteParams(sql, values);
      return { sql: result.sql, warnings: result.warnings, error: null };
    } catch (error) {
      return {
        sql,
        warnings: [],
        error: error instanceof ParamError ? error : new ParamError("", String(error)),
      };
    }
  }, [sql, values]);

  const warningsByParam = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const warning of preview.warnings) {
      (map[warning.name] ??= []).push(warning.message);
    }
    return map;
  }, [preview.warnings]);

  return (
    <div className="param-fill-card" role="dialog" aria-label={copy.title}>
      <div className="param-fill-title">{copy.title}</div>

      {params.map((param, index) => (
        <div className="fav-form-field" key={param.name}>
          <label className="fav-form-label" htmlFor={`param-${param.name}`}>
            {param.name}
            <span className="param-fill-type">{param.type}</span>
            {param.default !== undefined ? (
              <span className="param-fill-default">{copy.defaultHint(param.default)}</span>
            ) : null}
          </label>
          <input
            id={`param-${param.name}`}
            type="text"
            className="fav-form-input"
            value={values[param.name] ?? ""}
            autoFocus={index === 0}
            onChange={(event) =>
              setValues((prev) => ({ ...prev, [param.name]: event.target.value }))
            }
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" && !preview.error) {
                onSubmit(preview.sql);
              }
              if (event.key === "Escape") onCancel();
            }}
          />
          {(warningsByParam[param.name] ?? []).map((message) => (
            <div className="param-fill-warning" key={message}>
              {message}
            </div>
          ))}
        </div>
      ))}

      <div className="fav-form-field">
        <label className="fav-form-label">{copy.previewLabel}</label>
        <pre className="param-fill-preview">{preview.sql}</pre>
      </div>

      {preview.error ? <div className="param-fill-error">{preview.error.message}</div> : null}

      <div className="fav-form-actions">
        <button type="button" className="fav-form-cancel" onClick={onCancel}>
          {copy.cancelLabel}
        </button>
        <button
          type="button"
          className="fav-form-submit"
          disabled={preview.error !== null}
          onClick={() => onSubmit(preview.sql)}
        >
          {copy.runLabel}
        </button>
      </div>
    </div>
  );
}
