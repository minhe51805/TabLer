import type { ForeignKeyInfo } from "../../types";
import type { GridCellValue, ResolvedColumn } from "./hooks/useDataGrid";
import {
  getCellEditorType,
  getForeignKeyForColumn,
  getEnumValues,
  getSetValues,
  BooleanCellEditor,
  TextCellEditor,
  NumericCellEditor,
  DateTimeCellEditor,
  EnumCellEditor,
  SetCellEditor,
  JSONCellEditor,
  HexCellEditor,
  GeometryCellEditor,
  FKLookupCellEditor,
} from "./editors";
import type { ICellEditorProps } from "./editors/types";

export interface LookupValue {
  value: string | number;
  label: string;
}

export interface CellEditorParams {
  col: ResolvedColumn;
  value: GridCellValue;
  foreignKeys: ForeignKeyInfo[];
  /** Lookup values cache: key = `${table}|${column}` */
  lookupValuesCache?: Map<string, LookupValue[]>;
  onLoadLookupValues?: (table: string, column: string) => Promise<LookupValue[]>;
  connectionId?: string;
  editingSeedValue: string;
  editingDraftRef: { current: string };
  commitEditingCell: () => Promise<void>;
  cancelEditingCell: () => void;
  dateFormat?: string;
}

/**
 * Renders the inline editor matching the column's resolved editor type.
 * Extracted from the grid cell renderer so each concern stays in one module.
 */
export function renderCellEditor({
  col,
  value,
  foreignKeys,
  lookupValuesCache,
  onLoadLookupValues,
  connectionId,
  editingSeedValue,
  editingDraftRef,
  commitEditingCell,
  cancelEditingCell,
  dateFormat,
}: CellEditorParams): React.ReactElement {
  const fkInfo = getForeignKeyForColumn(col.name, foreignKeys);
  const enumValues = getEnumValues(col);
  const setValues = getSetValues(col);
  const editorType = getCellEditorType(col, fkInfo, enumValues);
  const lookupCacheKey = fkInfo ? `${fkInfo.referenced_table}|${fkInfo.referenced_column}` : "";
  const cachedLookupValues = lookupCacheKey ? (lookupValuesCache?.get(lookupCacheKey) ?? []) : [];

  const handleCommit = (resolvedValue: GridCellValue) => {
    editingDraftRef.current = String(resolvedValue ?? "NULL");
    void commitEditingCell();
  };

  const editorProps: ICellEditorProps = {
    column: col,
    value,
    seedValue: editingSeedValue,
    onCommit: handleCommit,
    onCancel: cancelEditingCell,
    onChange: (draft) => {
      editingDraftRef.current = draft;
    },
    inputRef: { current: null } as React.MutableRefObject<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>,
    isNullable: col.is_nullable ?? false,
    referencedTable: fkInfo?.referenced_table,
    referencedColumn: fkInfo?.referenced_column,
    lookupValues: cachedLookupValues,
    enumValues,
    setValues,
  };

  if (editorType === "date" || editorType === "datetime" || editorType === "time") {
    const dtType = editorType;
    return (
      <DateTimeCellEditor
        {...editorProps}
        editorType={dtType}
        dateFormat={dateFormat}
      />
    );
  }

  if (editorType === "foreign_key") {
    return (
      <FKLookupCellEditor
        {...editorProps}
        connectionId={connectionId || ""}
        onLoadLookupValues={async (table, column) => {
          const cacheKey = `${table}|${column}`;
          if (lookupValuesCache?.has(cacheKey)) {
            return lookupValuesCache.get(cacheKey)!;
          }
          if (onLoadLookupValues) {
            const values = await onLoadLookupValues(table, column);
            lookupValuesCache?.set(cacheKey, values);
            return values;
          }
          return [];
        }}
      />
    );
  }

  if (editorType === "boolean") return <BooleanCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLSelectElement | null>} />;
  if (editorType === "numeric") return <NumericCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLInputElement | null>} />;
  if (editorType === "enum") return <EnumCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLSelectElement | null>} />;
  if (editorType === "set") return <SetCellEditor {...editorProps} setValues={setValues} inputRef={{ current: null } as React.MutableRefObject<HTMLInputElement | null>} />;
  if (editorType === "json") return <JSONCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLTextAreaElement | null>} />;
  if (editorType === "hex") return <HexCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLTextAreaElement | null>} />;
  if (editorType === "geometry") return <GeometryCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLTextAreaElement | null>} />;
  return <TextCellEditor {...editorProps} inputRef={{ current: null } as React.MutableRefObject<HTMLInputElement | null>} />;
}
