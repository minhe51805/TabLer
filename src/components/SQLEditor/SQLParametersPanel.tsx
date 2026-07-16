import { Braces, SlidersHorizontal } from "lucide-react";
import type { QueryParameterType } from "../../types";
import type { SqlParameterDraft } from "../../utils/sql-parameters";

interface Props {
  names: string[];
  drafts: Record<string, SqlParameterDraft>;
  onChange: (name: string, next: SqlParameterDraft) => void;
}

const TYPES: Array<{ value: QueryParameterType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "integer", label: "Integer" },
  { value: "decimal", label: "Decimal" },
  { value: "boolean", label: "Boolean" },
  { value: "json", label: "JSON" },
  { value: "null", label: "NULL" },
];

export function SQLParametersPanel({ names, drafts, onChange }: Props) {
  if (names.length === 0) return null;
  return (
    <div className="sql-parameters-panel">
      <div className="sql-parameters-title"><SlidersHorizontal className="w-3.5 h-3.5" /><span>Parameters</span></div>
      <div className="sql-parameters-list">
        {names.map((name) => {
          const draft = drafts[name] ?? { value: "", dataType: "text" as const };
          return (
            <div className="sql-parameter-row" key={name}>
              <span className="sql-parameter-name"><Braces className="w-3 h-3" />{name}</span>
              <select value={draft.dataType} onChange={(event) => onChange(name, { ...draft, dataType: event.target.value as QueryParameterType })}>
                {TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
              {draft.dataType === "boolean" ? (
                <select value={draft.value || "false"} onChange={(event) => onChange(name, { ...draft, value: event.target.value })}><option value="false">false</option><option value="true">true</option></select>
              ) : draft.dataType === "null" ? <span className="sql-parameter-null">Database NULL</span> : (
                <input value={draft.value} onChange={(event) => onChange(name, { ...draft, value: event.target.value })} placeholder={draft.dataType === "json" ? '{"key":"value"}' : "Value"} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
