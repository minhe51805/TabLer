import {
  ChevronDown,
  ChevronRight,
  FileCode,
  GitBranch,
  Link2,
  ListTree,
  Loader2,
} from "lucide-react";
import type { ForeignKeyInfo, IndexInfo, TriggerInfo } from "../../../types";

type SectionKey = "indexes" | "foreign_keys" | "triggers" | "view_definition";

interface SectionRefs {
  current: Record<SectionKey, HTMLElement | null>;
}

// ---------------------------------------------------------------------------
// Indexes Section
// ---------------------------------------------------------------------------

interface IndexListProps {
  indexes: IndexInfo[];
  sectionRefs: SectionRefs;
  isActive: boolean;
  isExpanded: boolean;
  hasLoadedMetadata: boolean;
  isLoadingMetadata: boolean;
  metadataError: string | null;
  onToggle: () => void;
  onLoadMetadata: (options?: { force?: boolean }) => void;
}

export function IndexList({
  indexes,
  sectionRefs,
  isActive,
  isExpanded,
  hasLoadedMetadata,
  isLoadingMetadata,
  metadataError,
  onToggle,
  onLoadMetadata,
}: IndexListProps) {
  return (
    <section
      ref={(node) => {
        sectionRefs.current.indexes = node;
      }}
      className={`structure-section ${isActive ? "active" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="structure-section-toggle"
        aria-expanded={isExpanded}
      >
        <div className="structure-section-head">
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <div className="structure-section-icon">
            <ListTree className="w-4 h-4" />
          </div>
          <div className="structure-section-copy">
            <span className="structure-section-title">Indexes</span>
            <span className="structure-section-subtitle">
              Loaded only when needed to keep structure view fast.
            </span>
          </div>
        </div>
        <span className="structure-section-count">{hasLoadedMetadata ? indexes.length : "..."}</span>
      </button>

      {isExpanded && (
        <div className="structure-section-body">
          {!hasLoadedMetadata ? (
            <div className="structure-section-status">
              {isLoadingMetadata ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span>Loading indexes...</span>
                </>
              ) : (
                <>
                  <span>{metadataError || "Indexes are loaded on demand."}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onLoadMetadata({ force: true })}
                  >
                    Load now
                  </button>
                </>
              )}
            </div>
          ) : (
            <table className="structure-table">
              <thead>
                <tr>
                  <th className="structure-th">Name</th>
                  <th className="structure-th">Columns</th>
                  <th className="structure-th">Unique</th>
                  <th className="structure-th">Type</th>
                </tr>
              </thead>
              <tbody>
                {indexes.length > 0 ? (
                  indexes.map((idx, index) => (
                    <tr key={idx.name} className={`structure-row ${index % 2 !== 0 ? "alt" : ""}`}>
                      <td className="structure-td">
                        <span className="structure-name-text">{idx.name}</span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-code-chip" title={idx.columns.join(", ")}>
                          {idx.columns.join(", ")}
                        </span>
                      </td>
                      <td className="structure-td">
                        <span className={`structure-inline-pill ${idx.is_unique ? "primary" : ""}`}>
                          {idx.is_unique ? "YES" : "NO"}
                        </span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-inline-pill">{idx.index_type || "-"}</span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="structure-empty-row">
                      No indexes
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Foreign Keys Section
// ---------------------------------------------------------------------------

interface FKListProps {
  foreignKeys: ForeignKeyInfo[];
  sectionRefs: SectionRefs;
  isActive: boolean;
  isExpanded: boolean;
  hasLoadedMetadata: boolean;
  isLoadingMetadata: boolean;
  metadataError: string | null;
  onToggle: () => void;
  onLoadMetadata: (options?: { force?: boolean }) => void;
}

export function FKList({
  foreignKeys,
  sectionRefs,
  isActive,
  isExpanded,
  hasLoadedMetadata,
  isLoadingMetadata,
  metadataError,
  onToggle,
  onLoadMetadata,
}: FKListProps) {
  return (
    <section
      ref={(node) => {
        sectionRefs.current.foreign_keys = node;
      }}
      className={`structure-section ${isActive ? "active" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="structure-section-toggle"
        aria-expanded={isExpanded}
      >
        <div className="structure-section-head">
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <div className="structure-section-icon">
            <Link2 className="w-4 h-4" />
          </div>
          <div className="structure-section-copy">
            <span className="structure-section-title">Foreign Keys</span>
            <span className="structure-section-subtitle">
              Referential metadata is deferred until you ask for it.
            </span>
          </div>
        </div>
        <span className="structure-section-count">
          {hasLoadedMetadata ? foreignKeys.length : "..."}
        </span>
      </button>

      {isExpanded && (
        <div className="structure-section-body">
          {!hasLoadedMetadata ? (
            <div className="structure-section-status">
              {isLoadingMetadata ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span>Loading foreign keys...</span>
                </>
              ) : (
                <>
                  <span>{metadataError || "Foreign keys are loaded on demand."}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onLoadMetadata({ force: true })}
                  >
                    Load now
                  </button>
                </>
              )}
            </div>
          ) : (
            <table className="structure-table">
              <thead>
                <tr>
                  <th className="structure-th">Name</th>
                  <th className="structure-th">Column</th>
                  <th className="structure-th">Reference</th>
                </tr>
              </thead>
              <tbody>
                {foreignKeys.length > 0 ? (
                  foreignKeys.map((fk, index) => (
                    <tr key={fk.name} className={`structure-row ${index % 2 !== 0 ? "alt" : ""}`}>
                      <td className="structure-td">
                        <span className="structure-name-text">{fk.name}</span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-inline-pill type">{fk.column}</span>
                      </td>
                      <td className="structure-td">
                        <div className="structure-reference-cell">
                          <Link2 className="w-3.5 h-3.5" />
                          <span
                            className="structure-code-chip"
                            title={`${fk.referenced_table}.${fk.referenced_column}`}
                          >
                            {fk.referenced_table}.{fk.referenced_column}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="structure-empty-row">
                      No foreign keys
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// View Definition Section
// ---------------------------------------------------------------------------

interface ViewDefinitionProps {
  viewDefinition: string | null;
  sectionRefs: SectionRefs;
  isActive: boolean;
  isExpanded: boolean;
  hasLoadedMetadata: boolean;
  isLoadingMetadata: boolean;
  metadataError: string | null;
  onToggle: () => void;
  onLoadMetadata: (options?: { force?: boolean }) => void;
}

export function ViewDefinitionSection({
  viewDefinition,
  sectionRefs,
  isActive,
  isExpanded,
  hasLoadedMetadata,
  isLoadingMetadata,
  metadataError,
  onToggle,
  onLoadMetadata,
}: ViewDefinitionProps) {
  return (
    <section
      ref={(node) => {
        sectionRefs.current.view_definition = node;
      }}
      className={`structure-section ${isActive ? "active" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="structure-section-toggle"
        aria-expanded={isExpanded}
      >
        <div className="structure-section-head">
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <div className="structure-section-icon">
            <FileCode className="w-4 h-4" />
          </div>
          <div className="structure-section-copy">
            <span className="structure-section-title">View Definition</span>
            <span className="structure-section-subtitle">
              Inspect the SQL body behind this view.
            </span>
          </div>
        </div>
        <span className="structure-section-count">{viewDefinition ? "SQL" : "..."}</span>
      </button>

      {isExpanded && (
        <div className="structure-section-body">
          {!hasLoadedMetadata ? (
            <div className="structure-section-status">
              {isLoadingMetadata ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span>Loading view definition...</span>
                </>
              ) : (
                <>
                  <span>{metadataError || "View definition is loaded on demand."}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onLoadMetadata({ force: true })}
                  >
                    Load now
                  </button>
                </>
              )}
            </div>
          ) : (
            <pre className="structure-editor-preview">
              {viewDefinition || "No view definition is available for this object."}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Triggers Section
// ---------------------------------------------------------------------------

interface TriggerListProps {
  triggers: TriggerInfo[];
  sectionRefs: SectionRefs;
  isActive: boolean;
  isExpanded: boolean;
  hasLoadedMetadata: boolean;
  isLoadingMetadata: boolean;
  metadataError: string | null;
  onToggle: () => void;
  onLoadMetadata: (options?: { force?: boolean }) => void;
}

export function TriggerList({
  triggers,
  sectionRefs,
  isActive,
  isExpanded,
  hasLoadedMetadata,
  isLoadingMetadata,
  metadataError,
  onToggle,
  onLoadMetadata,
}: TriggerListProps) {
  return (
    <section
      ref={(node) => {
        sectionRefs.current.triggers = node;
      }}
      className={`structure-section ${isActive ? "active" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="structure-section-toggle"
        aria-expanded={isExpanded}
      >
        <div className="structure-section-head">
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <div className="structure-section-icon">
            <GitBranch className="w-4 h-4" />
          </div>
          <div className="structure-section-copy">
            <span className="structure-section-title">Triggers</span>
            <span className="structure-section-subtitle">
              Trigger metadata stays deferred until you open this section.
            </span>
          </div>
        </div>
        <span className="structure-section-count">{hasLoadedMetadata ? triggers.length : "..."}</span>
      </button>

      {isExpanded && (
        <div className="structure-section-body">
          {!hasLoadedMetadata ? (
            <div className="structure-section-status">
              {isLoadingMetadata ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span>Loading triggers...</span>
                </>
              ) : (
                <>
                  <span>{metadataError || "Triggers are loaded on demand."}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onLoadMetadata({ force: true })}
                  >
                    Load now
                  </button>
                </>
              )}
            </div>
          ) : (
            <table className="structure-table">
              <thead>
                <tr>
                  <th className="structure-th">Name</th>
                  <th className="structure-th">Timing</th>
                  <th className="structure-th">Event</th>
                  <th className="structure-th">Definition</th>
                </tr>
              </thead>
              <tbody>
                {triggers.length > 0 ? (
                  triggers.map((trigger, index) => (
                    <tr key={trigger.name} className={`structure-row ${index % 2 !== 0 ? "alt" : ""}`}>
                      <td className="structure-td">
                        <span className="structure-name-text">{trigger.name}</span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-inline-pill">{trigger.timing || "-"}</span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-inline-pill type">{trigger.event || "-"}</span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-code-chip" title={trigger.definition || "-"}>
                          {trigger.definition || "-"}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="structure-empty-row">
                      No triggers
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
