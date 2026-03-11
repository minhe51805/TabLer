import { useEffect, useState } from "react";
import {
  Key,
  ChevronDown,
  ChevronRight,
  Link,
  Columns3,
  ListTree,
  Link2,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { TableStructure as TableStructureType } from "../../types";

interface Props {
  connectionId: string;
  tableName: string;
  database?: string;
}

export function TableStructure({ connectionId, tableName, database }: Props) {
  const { getTableStructure } = useAppStore();
  const [structure, setStructure] = useState<TableStructureType | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["columns", "indexes", "foreign_keys"])
  );

  const toggleSection = (section: string) => {
    const next = new Set(expandedSections);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    setExpandedSections(next);
  };

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    getTableStructure(connectionId, tableName, database)
      .then((res) => {
        if (mounted) setStructure(res);
      })
      .catch(console.error)
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [connectionId, tableName, database, getTableStructure]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        Loading structure...
      </div>
    );
  }

  if (!structure) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        Failed to load structure
      </div>
    );
  }

  const sectionButtonCls =
    "w-full flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] px-3 py-2 rounded-md border border-white/10 bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(255,255,255,0.04)] transition-colors";

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="rounded-md border border-white/10 bg-[rgba(255,255,255,0.02)] overflow-hidden">
        <button onClick={() => toggleSection("columns")} className={sectionButtonCls}>
          {expandedSections.has("columns") ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <Columns3 className="w-4 h-4 text-[var(--accent)]" />
          Columns ({structure.columns.length})
        </button>
        {expandedSections.has("columns") && (
          <table className="w-full text-sm border-t border-[var(--border-color)]">
            <thead>
              <tr className="bg-[var(--bg-secondary)]/70">
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Column</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Type</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Nullable</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Default</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Extra</th>
              </tr>
            </thead>
            <tbody>
              {structure.columns.map((col) => (
                <tr key={col.name} className="border-b border-[var(--border-color)] last:border-0 hover:bg-[rgba(255,255,255,0.03)]">
                  <td className="px-3 py-2 flex items-center gap-1.5">
                    {col.is_primary_key && <Key className="w-3 h-3 text-[var(--warning)]" />}
                    <span className="text-[var(--text-primary)]">{col.name}</span>
                  </td>
                  <td className="px-3 py-2 text-[var(--accent)]">{col.column_type || col.data_type}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{col.is_nullable ? "YES" : "NO"}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{col.default_value || "-"}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{col.extra || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-md border border-white/10 bg-[rgba(255,255,255,0.02)] overflow-hidden">
        <button onClick={() => toggleSection("indexes")} className={sectionButtonCls}>
          {expandedSections.has("indexes") ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <ListTree className="w-4 h-4 text-[var(--accent)]" />
          Indexes ({structure.indexes.length})
        </button>
        {expandedSections.has("indexes") && (
          <table className="w-full text-sm border-t border-[var(--border-color)]">
            <thead>
              <tr className="bg-[var(--bg-secondary)]/70">
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Name</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Columns</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Unique</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Type</th>
              </tr>
            </thead>
            <tbody>
              {structure.indexes.map((idx) => (
                <tr key={idx.name} className="border-b border-[var(--border-color)] last:border-0 hover:bg-[rgba(255,255,255,0.03)]">
                  <td className="px-3 py-2 text-[var(--text-primary)]">{idx.name}</td>
                  <td className="px-3 py-2 text-[var(--accent)]">{idx.columns.join(", ")}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{idx.is_unique ? "YES" : "NO"}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{idx.index_type || "-"}</td>
                </tr>
              ))}
              {structure.indexes.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-3 text-center text-[var(--text-muted)]">No indexes</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-md border border-white/10 bg-[rgba(255,255,255,0.02)] overflow-hidden">
        <button onClick={() => toggleSection("foreign_keys")} className={sectionButtonCls}>
          {expandedSections.has("foreign_keys") ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <Link2 className="w-4 h-4 text-[var(--accent)]" />
          Foreign Keys ({structure.foreign_keys.length})
        </button>
        {expandedSections.has("foreign_keys") && (
          <table className="w-full text-sm border-t border-[var(--border-color)]">
            <thead>
              <tr className="bg-[var(--bg-secondary)]/70">
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Name</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Column</th>
                <th className="text-left px-3 py-2 text-[11px] font-bold text-[var(--text-muted)] border-b border-[var(--border-color)]">Reference</th>
              </tr>
            </thead>
            <tbody>
              {structure.foreign_keys.map((fk) => (
                <tr key={fk.name} className="border-b border-[var(--border-color)] last:border-0 hover:bg-[rgba(255,255,255,0.03)]">
                  <td className="px-3 py-2 text-[var(--text-primary)]">{fk.name}</td>
                  <td className="px-3 py-2 text-[var(--accent)]">{fk.column}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)] flex items-center gap-1">
                    <Link className="w-3 h-3" />
                    {fk.referenced_table}.{fk.referenced_column}
                  </td>
                </tr>
              ))}
              {structure.foreign_keys.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-3 text-center text-[var(--text-muted)]">No foreign keys</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
