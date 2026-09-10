import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../../../i18n";
import { emitAppToast } from "../../../utils/app-toast";
import {
  anonymizeRows,
  assertNoPrimaryKeyStrategies,
  type AnonymizerStrategy,
  type AnonymizerValue,
} from "../../../utils/anonymizer";
import { buildTsvContent } from "../../../utils/export-utils";
import type { ResolvedColumn } from "../hooks/useDataGrid";

interface DataGridAnonymizerModalProps {
  columns: ResolvedColumn[];
  dataRows: AnonymizerValue[][];
  onClose: () => void;
}

const STRATEGIES: Array<{ value: AnonymizerStrategy | "none"; labelKey: TranslationKey }> = [
  { value: "none", labelKey: "datagrid.anonymizer.strategyNone" },
  { value: "hash", labelKey: "datagrid.anonymizer.strategyHash" },
  { value: "redact", labelKey: "datagrid.anonymizer.strategyRedact" },
  { value: "null", labelKey: "datagrid.anonymizer.strategyNull" },
  { value: "fake-email", labelKey: "datagrid.anonymizer.strategyFakeEmail" },
  { value: "fake-name", labelKey: "datagrid.anonymizer.strategyFakeName" },
  { value: "fake-phone", labelKey: "datagrid.anonymizer.strategyFakePhone" },
  { value: "noise", labelKey: "datagrid.anonymizer.strategyNoise" },
];

/**
 * Choose per-column masking strategies, preview the result live, and copy a
 * masked TSV to the clipboard. Primary-key columns refuse strategies —
 * masked keys would break row identity (see assertNoPrimaryKeyStrategies).
 */
export function DataGridAnonymizerModal({ columns, dataRows, onClose }: DataGridAnonymizerModalProps) {
  const { t } = useI18n();
  const [strategyByIndex, setStrategyByIndex] = useState<Record<number, AnonymizerStrategy | "none">>({});
  const [salt, setSalt] = useState("");
  const [previewRows, setPreviewRows] = useState<AnonymizerValue[][]>([]);
  const [isCopying, setIsCopying] = useState(false);

  const activeStrategies = useMemo(() => {
    const map = new Map<number, AnonymizerStrategy>();
    for (const [index, strategy] of Object.entries(strategyByIndex)) {
      if (strategy !== "none") map.set(Number(index), strategy);
    }
    return map;
  }, [strategyByIndex]);

  const hasAnyStrategy = activeStrategies.size > 0;

  // Live preview of the first rows with the current strategy set.
  useEffect(() => {
    let cancelled = false;
    anonymizeRows(dataRows.slice(0, 5), activeStrategies, salt)
      .then((rows) => {
        if (!cancelled) setPreviewRows(rows);
      })
      .catch(() => {
        if (!cancelled) setPreviewRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeStrategies, dataRows, salt]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      assertNoPrimaryKeyStrategies(
        columns.flatMap((column, index) => (column.is_primary_key ? [index] : [])),
        activeStrategies,
      );
      const masked = await anonymizeRows(dataRows, activeStrategies, salt);
      const tsv = buildTsvContent(
        columns.map((column) => column.name),
        masked,
      );
      await navigator.clipboard.writeText(tsv);
      emitAppToast({
        title: t("datagrid.anonymizer.copiedTitle"),
        description: t("datagrid.anonymizer.copiedDescription", { count: masked.length }),
        tone: "success",
      });
      onClose();
    } catch (error) {
      emitAppToast({
        title: t("datagrid.anonymizer.failedTitle"),
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <div className="qs-overlay" role="presentation" onClick={onClose}>
      <div
        className="qs-panel data-import-panel"
        role="dialog"
        aria-label={t("datagrid.anonymizer.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="qs-input-row">
          <strong>
            <ShieldCheck size={14} className="inline-block mr-1" />
            {t("datagrid.anonymizer.title")}
          </strong>
          <button type="button" className="qs-clear-btn" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {dataRows.length === 0 ? (
          <div className="qs-empty">{t("datagrid.anonymizer.noRows")}</div>
        ) : (
          <>
            <div className="schema-diff-summary">
              <span>{t("datagrid.anonymizer.rowCount", { count: dataRows.length })}</span>
              <span>{t("datagrid.anonymizer.saltHint")}</span>
            </div>

            <div className="schema-diff-selects">
              <input
                value={salt}
                onChange={(event) => setSalt(event.target.value)}
                placeholder={t("datagrid.anonymizer.saltPlaceholder")}
                aria-label={t("datagrid.anonymizer.saltPlaceholder")}
              />
            </div>

            <div className="qs-list schema-diff-results">
              <div className="qs-item static global-search-match-kind">
                {t("datagrid.anonymizer.columnList")}
              </div>
              {columns.map((column, index) => (
                <div key={`${column.name}-${index}`} className="qs-item static">
                  <span className="global-search-match-label">
                    {column.name}
                    {column.is_primary_key ? " 🔑" : ""}
                  </span>
                  <select
                    value={strategyByIndex[index] ?? "none"}
                    disabled={Boolean(column.is_primary_key)}
                    onChange={(event) =>
                      setStrategyByIndex((current) => ({
                        ...current,
                        [index]: event.target.value as AnonymizerStrategy | "none",
                      }))
                    }
                    aria-label={`${t("datagrid.anonymizer.strategyFor")} ${column.name}`}
                  >
                    {STRATEGIES.map((strategy) => (
                      <option key={strategy.value} value={strategy.value}>
                        {t(strategy.labelKey)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="qs-list schema-diff-results">
              <div className="qs-item static global-search-match-kind">
                {t("datagrid.anonymizer.preview")}
              </div>
              {previewRows.map((row, rowIndex) => (
                <div key={`preview-${rowIndex}`} className="qs-item static">
                  <span className="global-search-match-label">
                    {row
                      .map((value) => (value === null ? "NULL" : String(value)))
                      .slice(0, 6)
                      .join(" | ")}
                  </span>
                </div>
              ))}
            </div>

            <div className="schema-diff-selects">
              <button
                type="button"
                className="global-search-mode active"
                disabled={!hasAnyStrategy || isCopying}
                onClick={() => {
                  setIsCopying(true);
                  void handleCopy();
                }}
              >
                <ShieldCheck size={13} /> {t("datagrid.anonymizer.copyTsv")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
