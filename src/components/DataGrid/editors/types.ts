import type { RefObject } from "react";
import type { ResolvedColumn, GridCellValue } from "../hooks/useDataGrid";

export type CellEditorType =
  | "text"
  | "boolean"
  | "date"
  | "datetime"
  | "time"
  | "numeric"
  | "foreign_key"
  | "enum"
  | "json"
  | "hex";

export interface CellEditorCommitResult {
  success: boolean;
  value?: GridCellValue;
  error?: string;
}

export interface ICellEditorProps {
  column: ResolvedColumn;
  value: GridCellValue;
  seedValue: string;
  onCommit: (value: GridCellValue) => void;
  onCancel: () => void;
  onChange: (draft: string) => void;
  inputRef?: RefObject<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>;
  isNullable: boolean;
  // FK-specific props
  referencedTable?: string;
  referencedColumn?: string;
  lookupValues?: Array<{ value: unknown; label: string }>;
  // Enum-specific props
  enumValues?: string[];
}
