import type { QueryResult } from "../../../types";

export interface FkPreviewTarget {
  table: string;
  column: string;
  value: string | number | boolean;
  rowIndex: number;
  colIndex: number;
}

interface FkPreviewPopoverProps {
  fkPreview: FkPreviewTarget;
  isLoadingFkPreview: boolean;
  fkPreviewData: QueryResult | null;
  onClose: () => void;
}

/** Inline popover previewing the referenced row behind a foreign-key cell. */
export function FkPreviewPopover({
  fkPreview,
  isLoadingFkPreview,
  fkPreviewData,
  onClose,
}: FkPreviewPopoverProps) {
  return (
    <div className="datagrid-fk-preview">
      <div className="datagrid-fk-preview-header">
        <span className="datagrid-fk-preview-title">
          FK Preview: {fkPreview.table}.{fkPreview.column}
        </span>
        <span className="datagrid-fk-preview-value">
          = {String(fkPreview.value)}
        </span>
        <button
          type="button"
          className="datagrid-fk-preview-close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="datagrid-fk-preview-body">
        {isLoadingFkPreview ? (
          <div className="datagrid-fk-preview-loading">Loading...</div>
        ) : fkPreviewData ? (
          fkPreviewData.rows.length > 0 ? (
            <table className="datagrid-fk-preview-table">
              <thead>
                <tr>
                  {fkPreviewData.columns.map((col) => (
                    <th key={col.name}>{col.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fkPreviewData.rows.slice(0, 3).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell === null ? "NULL" : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="datagrid-fk-preview-empty">No matching row found</div>
          )
        ) : (
          <div className="datagrid-fk-preview-empty">Press Ctrl+Enter on an FK cell to preview</div>
        )}
      </div>
    </div>
  );
}
