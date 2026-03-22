import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Code2, Copy, Eye, GitBranch, Loader2, Plus, Send, Sparkles, Table2, Trash2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import type { DatabaseType, TableInfo } from "../../types";

type WizardKind = "table" | "view" | "trigger";
type WizardDialect = "postgres" | "mysql" | "sqlite";

interface ColumnDraft {
  id: string;
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string;
}

interface Props {
  dbType: DatabaseType;
  database?: string;
  tables: TableInfo[];
  onClose: () => void;
  onCreateDraft: (title: string, sql: string) => void;
}

const TABLE_KIND_LABEL: Record<WizardKind, string> = {
  table: "Table",
  view: "View",
  trigger: "Trigger",
};

type AutocompleteField = "name" | "schema" | null;

function createEmptyColumn(): ColumnDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    dataType: "text",
    nullable: true,
    primaryKey: false,
    defaultValue: "",
  };
}

function resolveWizardDialect(dbType: DatabaseType): WizardDialect | null {
  switch (dbType) {
    case "postgresql":
    case "greenplum":
    case "cockroachdb":
    case "redshift":
      return "postgres";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlite":
      return "sqlite";
    default:
      return null;
  }
}

function quoteIdentifier(dialect: WizardDialect, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (dialect === "mysql") {
    return `\`${trimmed.replace(/`/g, "``")}\``;
  }

  return `"${trimmed.replace(/"/g, "\"\"")}"`;
}

function qualifyName(
  dialect: WizardDialect,
  name: string,
  schema: string,
  database?: string,
) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "";
  }

  if (dialect === "postgres") {
    const trimmedSchema = schema.trim() || "public";
    return `${quoteIdentifier(dialect, trimmedSchema)}.${quoteIdentifier(dialect, trimmedName)}`;
  }

  if (dialect === "mysql") {
    const trimmedDatabase = database?.trim();
    if (trimmedDatabase) {
      return `${quoteIdentifier(dialect, trimmedDatabase)}.${quoteIdentifier(dialect, trimmedName)}`;
    }
    return quoteIdentifier(dialect, trimmedName);
  }

  return quoteIdentifier(dialect, trimmedName);
}

function normalizeStatement(sql: string) {
  const trimmed = sql.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

function describeColumn(column: ColumnDraft) {
  const parts = [column.name.trim(), column.dataType.trim()];
  if (!column.nullable) {
    parts.push("not null");
  }
  if (column.primaryKey) {
    parts.push("primary key");
  }
  if (column.defaultValue.trim()) {
    parts.push(`default ${column.defaultValue.trim()}`);
  }
  return parts.filter(Boolean).join(" ");
}

function filterAutocompleteSuggestions(input: string, suggestions: string[]) {
  const needle = input.trim().toLowerCase();
  const exact = new Set<string>();

  const ranked = suggestions
    .filter((suggestion) => {
      const normalized = suggestion.toLowerCase();
      if (exact.has(normalized)) {
        return false;
      }
      exact.add(normalized);
      return !needle || normalized.includes(needle);
    })
    .sort((left, right) => {
      const leftNormalized = left.toLowerCase();
      const rightNormalized = right.toLowerCase();
      const leftStarts = needle ? leftNormalized.startsWith(needle) : false;
      const rightStarts = needle ? rightNormalized.startsWith(needle) : false;
      if (leftStarts !== rightStarts) {
        return leftStarts ? -1 : 1;
      }
      return left.localeCompare(right);
    });

  return ranked.slice(0, 8);
}

function buildTableSql(
  dialect: WizardDialect,
  name: string,
  schema: string,
  database: string | undefined,
  columns: ColumnDraft[],
) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { sql: "", error: "Table name is required." };
  }

  const sanitizedColumns = columns.filter(
    (column) => column.name.trim() && column.dataType.trim(),
  );

  if (sanitizedColumns.length === 0) {
    return { sql: "", error: "Add at least one column." };
  }

  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const column of sanitizedColumns) {
    const normalized = column.name.trim().toLowerCase();
    if (seenNames.has(normalized)) {
      duplicateNames.add(column.name.trim());
    }
    seenNames.add(normalized);
  }

  if (duplicateNames.size > 0) {
    return {
      sql: "",
      error: `Duplicate column names: ${Array.from(duplicateNames).join(", ")}.`,
    };
  }

  const primaryKeys = sanitizedColumns.filter((column) => column.primaryKey);
  const lines = sanitizedColumns.map((column) => {
    const parts = [
      `${quoteIdentifier(dialect, column.name)} ${column.dataType.trim()}`,
    ];

    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    if (column.defaultValue.trim()) {
      parts.push(`DEFAULT ${column.defaultValue.trim()}`);
    }

    return parts.join(" ");
  });

  if (primaryKeys.length > 0) {
    lines.push(
      `PRIMARY KEY (${primaryKeys
        .map((column) => quoteIdentifier(dialect, column.name))
        .join(", ")})`,
    );
  }

  const tableRef = qualifyName(dialect, trimmedName, schema, database);
  return {
    sql: `CREATE TABLE ${tableRef} (\n  ${lines.join(",\n  ")}\n);`,
    error: "",
  };
}

function buildViewSql(
  dialect: WizardDialect,
  name: string,
  schema: string,
  database: string | undefined,
  body: string,
) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { sql: "", error: "View name is required." };
  }

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { sql: "", error: "View query is required." };
  }

  const viewRef = qualifyName(dialect, trimmedName, schema, database);
  const replacePrefix = dialect === "sqlite" ? "CREATE VIEW" : "CREATE OR REPLACE VIEW";
  return {
    sql: `${replacePrefix} ${viewRef} AS\n${trimmedBody.replace(/;+\s*$/, "")};`,
    error: "",
  };
}

function buildTriggerSql(
  dialect: WizardDialect,
  dbType: DatabaseType,
  name: string,
  schema: string,
  database: string | undefined,
  tableName: string,
  timing: string,
  event: string,
  body: string,
) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { sql: "", error: "Trigger name is required." };
  }

  if (!tableName.trim()) {
    return { sql: "", error: "Choose a target table for the trigger." };
  }

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { sql: "", error: "Trigger body is required." };
  }

  const targetTableRef = qualifyName(dialect, tableName, schema, database);
  const triggerRef = quoteIdentifier(dialect, trimmedName);

  if (dialect === "postgres") {
    if (dbType === "redshift") {
      return {
        sql: "",
        error: "Trigger scaffolding is not enabled for Redshift in this build.",
      };
    }

    const functionName = `${trimmedName}_fn`;
    const functionRef = qualifyName(dialect, functionName, schema, database);
    const returnKeyword = event === "DELETE" ? "OLD" : "NEW";

    return {
      sql: [
        `CREATE OR REPLACE FUNCTION ${functionRef}()`,
        "RETURNS trigger",
        "LANGUAGE plpgsql",
        "AS $$",
        "BEGIN",
        `  ${trimmedBody.replace(/\n/g, "\n  ")}`,
        `  RETURN ${returnKeyword};`,
        "END;",
        "$$;",
        "",
        `DROP TRIGGER IF EXISTS ${triggerRef} ON ${targetTableRef};`,
        `CREATE TRIGGER ${triggerRef}`,
        `${timing} ${event} ON ${targetTableRef}`,
        "FOR EACH ROW",
        `EXECUTE FUNCTION ${functionRef}();`,
      ].join("\n"),
      error: "",
    };
  }

  if (dialect === "mysql") {
    return {
      sql: [
        `DROP TRIGGER IF EXISTS ${triggerRef};`,
        `CREATE TRIGGER ${triggerRef}`,
        `${timing} ${event} ON ${targetTableRef}`,
        "FOR EACH ROW",
        normalizeStatement(trimmedBody),
      ].join("\n"),
      error: "",
    };
  }

  return {
    sql: [
      `DROP TRIGGER IF EXISTS ${triggerRef};`,
      `CREATE TRIGGER ${triggerRef}`,
      `${timing} ${event} ON ${targetTableRef}`,
      "BEGIN",
      `  ${normalizeStatement(trimmedBody).replace(/\n/g, "\n  ")}`,
      "END;",
    ].join("\n"),
    error: "",
  };
}

export function CreateSchemaObjectModal({
  dbType,
  database,
  tables,
  onClose,
  onCreateDraft,
}: Props) {
  const dialect = resolveWizardDialect(dbType);
  const {
    askAI,
    aiConfigs,
    activeConnectionId,
    currentDatabase,
  } = useAppStore(
    useShallow((state) => ({
      askAI: state.askAI,
      aiConfigs: state.aiConfigs,
      activeConnectionId: state.activeConnectionId,
      currentDatabase: state.currentDatabase,
    })),
  );
  const supportsWizard = !!dialect;
  const supportsTrigger = !!dialect && dbType !== "redshift";
  const availableKinds = (supportsTrigger
    ? ["table", "view", "trigger"]
    : ["table", "view"]) as WizardKind[];
  const defaultSchema = dialect === "postgres" ? "public" : "";
  const tableOptions = useMemo(
    () => tables.filter((table) => table.table_type !== "VIEW"),
    [tables],
  );
  const objectNameSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const values = tables
      .map((table) => table.name.trim())
      .filter((tableName) => tableName.length > 0)
      .filter((tableName) => {
        const normalized = tableName.toLowerCase();
        if (seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      })
      .sort((left, right) => left.localeCompare(right));

    return values;
  }, [tables]);
  const schemaSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const values = tables
      .map((table) => (table.schema || "").trim())
      .filter((schemaName) => schemaName.length > 0)
      .filter((schemaName) => {
        const normalized = schemaName.toLowerCase();
        if (seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      })
      .sort((left, right) => left.localeCompare(right));

    return values;
  }, [tables]);

  const [kind, setKind] = useState<WizardKind>("table");
  const [name, setName] = useState("");
  const [schema, setSchema] = useState(defaultSchema);
  const [activeAutocomplete, setActiveAutocomplete] = useState<AutocompleteField>(null);
  const [tableColumns, setTableColumns] = useState<ColumnDraft[]>([
    createEmptyColumn(),
    createEmptyColumn(),
  ]);
  const [viewBody, setViewBody] = useState("SELECT\n  *\nFROM your_source;");
  const [triggerTable, setTriggerTable] = useState("");
  const [triggerTiming, setTriggerTiming] = useState("BEFORE");
  const [triggerEvent, setTriggerEvent] = useState("INSERT");
  const [triggerBody, setTriggerBody] = useState(
    dialect === "mysql"
      ? "SET NEW.updated_at = NOW()"
      : "-- write trigger logic here",
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isMiniAiOpen, setIsMiniAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const activeProvider = aiConfigs.find((config) => config.is_enabled);
  const filteredNameSuggestions = useMemo(
    () => filterAutocompleteSuggestions(name, objectNameSuggestions),
    [name, objectNameSuggestions],
  );
  const filteredSchemaSuggestions = useMemo(
    () => filterAutocompleteSuggestions(schema, schemaSuggestions),
    [schema, schemaSuggestions],
  );

  const sqlPreview = useMemo(() => {
    if (!supportsWizard || !dialect) {
      return { sql: "", error: "This database type does not have a create-object wizard yet." };
    }

    if (kind === "table") {
      return buildTableSql(dialect, name, schema, database, tableColumns);
    }

    if (kind === "view") {
      return buildViewSql(dialect, name, schema, database, viewBody);
    }

    return buildTriggerSql(
      dialect,
      dbType,
      name,
      schema,
      database,
      triggerTable,
      triggerTiming,
      triggerEvent,
      triggerBody,
    );
  }, [
    database,
    dbType,
    dialect,
    kind,
    name,
    schema,
    supportsWizard,
    tableColumns,
    triggerBody,
    triggerEvent,
    triggerTable,
    triggerTiming,
    viewBody,
  ]);

  const handleAddColumn = () => {
    setTableColumns((prev) => [...prev, createEmptyColumn()]);
  };

  const handleRemoveColumn = (columnId: string) => {
    setTableColumns((prev) =>
      prev.length > 1 ? prev.filter((column) => column.id !== columnId) : prev,
    );
  };

  const handleColumnChange = (
    columnId: string,
    field: keyof ColumnDraft,
    value: string | boolean,
  ) => {
    setTableColumns((prev) =>
      prev.map((column) =>
        column.id === columnId ? { ...column, [field]: value } : column,
      ),
    );
  };

  const handleCreateDraft = () => {
    if (sqlPreview.error) {
      setValidationError(sqlPreview.error);
      return;
    }

    const trimmedName = name.trim() || TABLE_KIND_LABEL[kind];
    const title = `Create ${TABLE_KIND_LABEL[kind]} ${trimmedName}`;
    onCreateDraft(title, sqlPreview.sql);
    onClose();
  };

  const buildAiPrompt = () => {
    const schemaHint =
      dialect === "postgres" ? ` in schema ${schema.trim() || "public"}` : "";

    if (kind === "table") {
      const describedColumns = tableColumns
        .filter((column) => column.name.trim() || column.dataType.trim())
        .map(describeColumn)
        .filter(Boolean);

      return [
        `Help me design a ${dbType} CREATE TABLE statement for "${name.trim() || "new_table"}"${schemaHint}.`,
        describedColumns.length > 0
          ? `Current draft columns: ${describedColumns.join(", ")}.`
          : "I have not finalized the columns yet.",
        "Return only SQL, and keep it production-friendly.",
      ].join(" ");
    }

    if (kind === "view") {
      return [
        `Help me draft a ${dbType} CREATE VIEW statement for "${name.trim() || "new_view"}"${schemaHint}.`,
        viewBody.trim()
          ? `Current query idea: ${viewBody.trim()}`
          : "I need a clean starting SELECT body.",
        "Return only SQL.",
      ].join(" ");
    }

    return [
      `Help me draft a ${dbType} trigger named "${name.trim() || "new_trigger"}"${schemaHint}.`,
      triggerTable.trim()
        ? `It should run ${triggerTiming} ${triggerEvent} on table "${triggerTable.trim()}".`
        : `It should become a ${triggerTiming} ${triggerEvent} trigger.`,
      triggerBody.trim()
        ? `Current logic idea: ${triggerBody.trim()}`
        : "I need help writing the trigger body.",
      "Return only SQL.",
    ].join(" ");
  };

  const handleAskAI = () => {
    setIsMiniAiOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setAiPrompt(buildAiPrompt());
        setAiError(null);
      }
      return nextOpen;
    });
  };

  const handleGenerateAiDraft = async () => {
    if (!activeConnectionId) {
      setAiError("Connect to a database first.");
      return;
    }

    if (!activeProvider) {
      setAiError("Enable an AI provider first in AI Settings.");
      return;
    }

    if (!aiPrompt.trim()) {
      setAiError("Describe what you want the AI to build first.");
      return;
    }

    setIsAiLoading(true);
    setAiError(null);

    try {
      const tableNames = tables
        .map((table) => (table.schema ? `${table.schema}.${table.name}` : table.name))
        .slice(0, 30);
      const context = activeProvider.allow_schema_context
        ? [
            `Database: ${database || currentDatabase || "default"}`,
            `Available tables: ${tableNames.join(", ") || "none yet"}`,
            "You are helping inside a schema wizard. Return only SQL unless a clarification is unavoidable.",
          ].join("\n")
        : "";

      const response = await askAI(aiPrompt, context, "panel");
      setAiResponse(response.trim());
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleCopyAiResponse = async () => {
    if (!aiResponse) return;
    await navigator.clipboard.writeText(aiResponse);
  };

  const handleOpenAiDraft = () => {
    if (!aiResponse.trim()) {
      setAiError("Generate SQL first.");
      return;
    }

    const trimmedName = name.trim() || TABLE_KIND_LABEL[kind];
    onCreateDraft(`AI ${TABLE_KIND_LABEL[kind]} ${trimmedName}`, aiResponse.trim());
    onClose();
  };

  const modal = (
    <div className="schema-wizard-overlay">
      <div className="schema-wizard-modal">
        <header className="schema-wizard-header">
          <div className="schema-wizard-copy">
            <span className="panel-kicker">Schema Builder</span>
            <h2 className="schema-wizard-title">Create database objects</h2>
            <p className="schema-wizard-subtitle">
              Build a table, view, or trigger from a guided form, then review the SQL draft before running it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="panel-header-action"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {!supportsWizard ? (
          <div className="schema-wizard-empty">
            <p>This object wizard is not wired into {dbType} yet.</p>
          </div>
        ) : (
          <>
            <div className="schema-wizard-tabs">
              {availableKinds.map((wizardKind) => (
                <button
                  key={wizardKind}
                  type="button"
                  className={`schema-wizard-tab ${wizardKind === kind ? "active" : ""}`}
                  onClick={() => {
                    setKind(wizardKind);
                    setValidationError(null);
                  }}
                >
                  {wizardKind === "table" && <Table2 className="w-4 h-4" />}
                  {wizardKind === "view" && <Eye className="w-4 h-4" />}
                  {wizardKind === "trigger" && <GitBranch className="w-4 h-4" />}
                  <span>{TABLE_KIND_LABEL[wizardKind]}</span>
                </button>
              ))}
            </div>

            <div className="schema-wizard-body">
              <div className="schema-wizard-form">
                <div className="schema-wizard-grid">
                  <label className="field-group field-group-autocomplete">
                    <span className="field-label">{TABLE_KIND_LABEL[kind]} name</span>
                    <input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setValidationError(null);
                        setActiveAutocomplete("name");
                      }}
                      onFocus={() => setActiveAutocomplete("name")}
                      onBlur={() => {
                        window.setTimeout(() => {
                          setActiveAutocomplete((current) => (current === "name" ? null : current));
                        }, 120);
                      }}
                      placeholder={
                        kind === "table"
                          ? "orders"
                          : kind === "view"
                            ? "active_orders"
                            : "orders_set_timestamp"
                      }
                      className="schema-wizard-input"
                    />
                    {activeAutocomplete === "name" && filteredNameSuggestions.length > 0 && (
                      <div className="schema-wizard-autocomplete">
                        {filteredNameSuggestions.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            className="schema-wizard-autocomplete-item"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              setName(suggestion);
                              setValidationError(null);
                              setActiveAutocomplete(null);
                            }}
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    )}
                  </label>

                  {dialect === "postgres" && (
                    <label className="field-group field-group-autocomplete">
                      <span className="field-label">Schema</span>
                      <input
                        value={schema}
                        onChange={(event) => {
                          setSchema(event.target.value);
                          setValidationError(null);
                          setActiveAutocomplete("schema");
                        }}
                        onFocus={() => setActiveAutocomplete("schema")}
                        onBlur={() => {
                          window.setTimeout(() => {
                            setActiveAutocomplete((current) => (current === "schema" ? null : current));
                          }, 120);
                        }}
                        placeholder="public"
                        className="schema-wizard-input"
                      />
                      {activeAutocomplete === "schema" && filteredSchemaSuggestions.length > 0 && (
                        <div className="schema-wizard-autocomplete">
                          {filteredSchemaSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              className="schema-wizard-autocomplete-item"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                setSchema(suggestion);
                                setValidationError(null);
                                setActiveAutocomplete(null);
                              }}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      )}
                    </label>
                  )}
                </div>

                {kind === "table" && (
                  <div className="schema-wizard-section">
                    <div className="schema-wizard-section-head">
                      <div>
                        <h3>Columns</h3>
                        <p>Define the starter shape of the table.</p>
                      </div>
                      <button type="button" className="btn btn-secondary" onClick={handleAddColumn}>
                        <Plus className="w-4 h-4" />
                        Add Column
                      </button>
                    </div>

                    <div className="schema-wizard-column-list">
                      {tableColumns.map((column) => (
                        <div key={column.id} className="schema-wizard-column-card">
                          <div className="schema-wizard-grid compact">
                            <label className="field-group">
                              <span className="field-label">Name</span>
                              <input
                                value={column.name}
                                onChange={(event) =>
                                  handleColumnChange(column.id, "name", event.target.value)
                                }
                                placeholder="id"
                                className="schema-wizard-input"
                              />
                            </label>
                            <label className="field-group">
                              <span className="field-label">Type</span>
                              <input
                                value={column.dataType}
                                onChange={(event) =>
                                  handleColumnChange(column.id, "dataType", event.target.value)
                                }
                                placeholder="uuid"
                                className="schema-wizard-input"
                              />
                            </label>
                            <label className="field-group">
                              <span className="field-label">Default</span>
                              <input
                                value={column.defaultValue}
                                onChange={(event) =>
                                  handleColumnChange(column.id, "defaultValue", event.target.value)
                                }
                                placeholder="now()"
                                className="schema-wizard-input"
                              />
                            </label>
                          </div>

                          <div className="schema-wizard-column-flags">
                            <label className="schema-wizard-checkbox">
                              <input
                                type="checkbox"
                                checked={!column.nullable}
                                onChange={(event) =>
                                  handleColumnChange(column.id, "nullable", !event.target.checked)
                                }
                              />
                              <span>Not null</span>
                            </label>
                            <label className="schema-wizard-checkbox">
                              <input
                                type="checkbox"
                                checked={column.primaryKey}
                                onChange={(event) =>
                                  handleColumnChange(column.id, "primaryKey", event.target.checked)
                                }
                              />
                              <span>Primary key</span>
                            </label>
                            <button
                              type="button"
                              onClick={() => handleRemoveColumn(column.id)}
                              className="schema-wizard-remove"
                              disabled={tableColumns.length <= 1}
                              title="Remove column"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {kind === "view" && (
                  <div className="schema-wizard-section">
                    <div className="schema-wizard-section-head">
                      <div>
                        <h3>View query</h3>
                        <p>Paste the SELECT statement that defines the view.</p>
                      </div>
                    </div>
                    <textarea
                      value={viewBody}
                      onChange={(event) => {
                        setViewBody(event.target.value);
                        setValidationError(null);
                      }}
                      className="schema-wizard-textarea"
                      spellCheck={false}
                    />
                  </div>
                )}

                {kind === "trigger" && (
                  <div className="schema-wizard-section">
                    <div className="schema-wizard-grid compact">
                      <label className="field-group">
                        <span className="field-label">Target table</span>
                        <select
                          value={triggerTable}
                          onChange={(event) => {
                            setTriggerTable(event.target.value);
                            setValidationError(null);
                          }}
                          className="schema-wizard-select"
                        >
                          <option value="">Choose table...</option>
                          {tableOptions.map((table) => {
                            const qualifiedName = table.schema
                              ? `${table.schema}.${table.name}`
                              : table.name;
                            return (
                              <option key={qualifiedName} value={table.name}>
                                {qualifiedName}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <label className="field-group">
                        <span className="field-label">Timing</span>
                        <select
                          value={triggerTiming}
                          onChange={(event) => {
                            setTriggerTiming(event.target.value);
                            setValidationError(null);
                          }}
                          className="schema-wizard-select"
                        >
                          <option value="BEFORE">Before</option>
                          <option value="AFTER">After</option>
                        </select>
                      </label>
                      <label className="field-group">
                        <span className="field-label">Event</span>
                        <select
                          value={triggerEvent}
                          onChange={(event) => {
                            setTriggerEvent(event.target.value);
                            setValidationError(null);
                          }}
                          className="schema-wizard-select"
                        >
                          <option value="INSERT">Insert</option>
                          <option value="UPDATE">Update</option>
                          <option value="DELETE">Delete</option>
                        </select>
                      </label>
                    </div>

                    <div className="schema-wizard-section-head">
                      <div>
                        <h3>Trigger body</h3>
                        <p>
                          {dialect === "mysql"
                            ? "Use a single statement body for MySQL/MariaDB."
                            : dialect === "postgres"
                              ? "Write the logic that should run inside the trigger function."
                              : "Write one or more SQL statements for the trigger body."}
                        </p>
                      </div>
                    </div>
                    <textarea
                      value={triggerBody}
                      onChange={(event) => {
                        setTriggerBody(event.target.value);
                        setValidationError(null);
                      }}
                      className="schema-wizard-textarea"
                      spellCheck={false}
                    />
                  </div>
                )}
              </div>

              <aside className="schema-wizard-preview">
                <div className="schema-wizard-preview-head">
                  <div>
                    <h3>SQL Draft</h3>
                    <p>Review before it lands in a query tab.</p>
                  </div>
                </div>
                <pre className="schema-wizard-preview-code">
                  <code>{sqlPreview.sql || "-- SQL preview will appear here."}</code>
                </pre>
                {(validationError || sqlPreview.error) && (
                  <div className="schema-wizard-error">
                    {validationError || sqlPreview.error}
                  </div>
                )}
              </aside>
            </div>

            <footer className="schema-wizard-footer">
              <div className="schema-wizard-footer-note">
                <Code2 className="w-4 h-4" />
                <span>The wizard creates a SQL draft first so you can review or edit it.</span>
              </div>
              <div className="schema-wizard-footer-actions">
                <button type="button" className="btn btn-secondary schema-wizard-ai-btn" onClick={handleAskAI}>
                  <Sparkles className="w-4 h-4" />
                  AI
                </button>
                <button type="button" className="btn btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={handleCreateDraft}>
                  Open SQL Draft
                </button>
              </div>
            </footer>

            {isMiniAiOpen && (
              <div className="schema-wizard-ai-popover">
                <div className="schema-wizard-ai-head">
                  <div className="schema-wizard-ai-copy">
                    <span className="schema-wizard-ai-kicker">AI Assistant</span>
                    <strong className="schema-wizard-ai-title">Draft with AI</strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsMiniAiOpen(false)}
                    className="panel-header-action"
                    title="Close AI assistant"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  className="schema-wizard-ai-textarea"
                  placeholder="Ask AI to help finish this table, view, or trigger..."
                  spellCheck={false}
                />

                <div className="schema-wizard-ai-toolbar">
                  <span className="schema-wizard-ai-note">
                    {activeProvider
                      ? `${activeProvider.name}${activeProvider.allow_schema_context ? " | schema-aware" : " | prompt-only"}`
                      : "No AI provider enabled"}
                  </span>
                  <button
                    type="button"
                    onClick={handleGenerateAiDraft}
                    className="btn btn-primary"
                    disabled={isAiLoading}
                  >
                    {isAiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
                    {isAiLoading ? "Thinking..." : "Generate"}
                  </button>
                </div>

                {aiError && <div className="schema-wizard-error">{aiError}</div>}

                {aiResponse && (
                  <div className="schema-wizard-ai-response">
                    <pre className="schema-wizard-ai-code">
                      <code>{aiResponse}</code>
                    </pre>
                    <div className="schema-wizard-ai-response-actions">
                      <button type="button" className="btn btn-secondary" onClick={handleCopyAiResponse}>
                        <Copy className="w-4 h-4" />
                        Copy
                      </button>
                      <button type="button" className="btn btn-primary" onClick={handleOpenAiDraft}>
                        <Send className="w-4 h-4" />
                        Open Draft
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return modal;
  }

  return createPortal(modal, document.body);
}
