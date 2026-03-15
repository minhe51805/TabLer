import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  FileCode,
  Key,
  Link,
  Link2,
  ListTree,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type {
  ColumnDetail,
  DatabaseType,
  ForeignKeyInfo,
  IndexInfo,
  TableStructure as TableStructureType,
} from "../../types";

interface Props {
  connectionId: string;
  tableName: string;
  database?: string;
  isActive?: boolean;
}

type SectionKey = "columns" | "indexes" | "foreign_keys";
type DefaultMode = "keep" | "set" | "drop";

interface ColumnEditorState {
  originalName: string;
  name: string;
  dataType: string;
  nullable: boolean;
  defaultMode: DefaultMode;
  defaultValue: string;
  isPrimaryKey: boolean;
  extra: string;
}

interface BuildColumnSqlResult {
  statements: string[];
  error?: string;
}

interface StagedColumnChange {
  original: ColumnDetail;
  draft: ColumnEditorState;
  statements: string[];
}

type StructureToastTone = "success" | "info" | "error";

interface StructureToast {
  id: number;
  tone: StructureToastTone;
  title: string;
  description?: string;
  isClosing: boolean;
}

const DEFAULT_SECTION_STATE = new Set<SectionKey>(["columns"]);
const COLUMN_LOAD_TIMEOUT_MS = 3500;
const METADATA_LOAD_TIMEOUT_MS = 8000;

const columnCache = new Map<string, ColumnDetail[]>();
const fullStructureCache = new Map<string, TableStructureType>();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function splitQualifiedTableName(table: string) {
  const [schema, ...rest] = table.split(".");
  if (rest.length === 0) {
    return { schema: "public", name: schema };
  }
  return {
    schema,
    name: rest.join("."),
  };
}

function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function asString(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNullableString(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function asBoolean(value: string | number | boolean | null | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value.toLowerCase() === "t" || value === "1";
  }
  return false;
}

function quoteIdentifier(dbType: DatabaseType, value: string) {
  const normalized = value.trim();
  if (dbType === "mysql") {
    return `\`${normalized.replace(/`/g, "``")}\``;
  }
  return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function qualifyTableName(dbType: DatabaseType, tableName: string, database?: string) {
  const parts = tableName
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  if (dbType === "mysql" && parts.length === 1 && database) {
    parts.unshift(database);
  }

  return parts.map((part) => quoteIdentifier(dbType, part)).join(".");
}

function buildColumnAlterStatements(
  dbType: DatabaseType,
  tableName: string,
  database: string | undefined,
  original: ColumnDetail,
  editor: ColumnEditorState
): BuildColumnSqlResult {
  if (dbType === "sqlite") {
    return {
      statements: [],
      error: "SQLite column changes are not wired into direct actions yet.",
    };
  }

  const nextName = editor.name.trim();
  const nextType = editor.dataType.trim();
  const originalType = (original.column_type || original.data_type || "").trim();
  const originalDefault = (original.default_value || "").trim();
  const nextDefault = editor.defaultValue.trim();
  const tableRef = qualifyTableName(dbType, tableName, database);
  const statements: string[] = [];

  if (!nextName) {
    return { statements: [], error: "Column name is required." };
  }

  if (!nextType) {
    return { statements: [], error: "Column type is required." };
  }

  let currentName = original.name;

  if (nextName !== original.name) {
    statements.push(
      `ALTER TABLE ${tableRef} RENAME COLUMN ${quoteIdentifier(dbType, original.name)} TO ${quoteIdentifier(dbType, nextName)}`
    );
    currentName = nextName;
  }

  if (dbType === "postgresql") {
    if (nextType !== originalType) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} TYPE ${nextType}`
      );
    }

    if (!original.is_primary_key && editor.nullable !== original.is_nullable) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} ${editor.nullable ? "DROP" : "SET"} NOT NULL`
      );
    }

    if (editor.defaultMode === "set") {
      if (!nextDefault) {
        return { statements: [], error: "Default expression is empty." };
      }
      if (nextDefault !== originalDefault) {
        statements.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} SET DEFAULT ${nextDefault}`
        );
      }
    }

    if (editor.defaultMode === "drop" && originalDefault) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} DROP DEFAULT`
      );
    }

    return { statements };
  }

  const definitionChanged = nextType !== originalType || editor.nullable !== original.is_nullable;
  const extraClause = editor.extra.trim();

  if (definitionChanged) {
    const parts = [
      `ALTER TABLE ${tableRef} MODIFY COLUMN ${quoteIdentifier(dbType, currentName)} ${nextType}`,
      editor.nullable && !editor.isPrimaryKey ? "NULL" : "NOT NULL",
    ];

    if (editor.defaultMode === "set") {
      if (!nextDefault) {
        return { statements: [], error: "Default expression is empty." };
      }
      parts.push(`DEFAULT ${nextDefault}`);
    } else if (editor.defaultMode === "keep" && originalDefault) {
      parts.push(`DEFAULT ${originalDefault}`);
    }

    if (extraClause && extraClause !== "-") {
      parts.push(extraClause);
    }

    statements.push(parts.join(" "));
    return { statements };
  }

  if (editor.defaultMode === "set") {
    if (!nextDefault) {
      return { statements: [], error: "Default expression is empty." };
    }
    if (nextDefault !== originalDefault) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} SET DEFAULT ${nextDefault}`
      );
    }
  }

  if (editor.defaultMode === "drop" && originalDefault) {
    statements.push(
      `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} DROP DEFAULT`
    );
  }

  return { statements };
}

function createEditorState(column: ColumnDetail, draft?: ColumnEditorState): ColumnEditorState {
  if (draft) {
    return { ...draft };
  }

  return {
    originalName: column.name,
    name: column.name,
    dataType: column.column_type || column.data_type,
    nullable: column.is_nullable,
    defaultMode: column.default_value ? "keep" : "drop",
    defaultValue: column.default_value || "",
    isPrimaryKey: column.is_primary_key,
    extra: column.extra || "",
  };
}

function applyDraftToColumn(column: ColumnDetail, draft?: ColumnEditorState): ColumnDetail {
  if (!draft) return column;

  return {
    ...column,
    name: draft.name.trim() || column.name,
    data_type: draft.dataType.trim() || column.data_type,
    column_type: draft.dataType.trim() || column.column_type || column.data_type,
    is_nullable: draft.nullable,
    default_value:
      draft.defaultMode === "set"
        ? draft.defaultValue.trim() || undefined
        : draft.defaultMode === "drop"
          ? undefined
          : column.default_value,
    extra: draft.extra.trim() || column.extra,
  };
}

function getDefaultValueForType(dataType: string) {
  const type = dataType.toLowerCase();
  if (
    type.includes("int") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("real")
  ) {
    return "0";
  }
  if (type.includes("bool")) {
    return "false";
  }
  if (type.includes("uuid")) {
    return "gen_random_uuid()";
  }
  if (type.includes("date") || type.includes("time")) {
    return "CURRENT_TIMESTAMP";
  }
  if (type.includes("json")) {
    return "'{}'::jsonb";
  }
  return "''";
}

function formatDbError(error: unknown, tableName: string) {
  const message = error instanceof Error ? error.message : String(error);
  const displayTable = tableName.split(".").pop() || tableName;

  if (message.includes("must be owner of table")) {
    return `Permission denied: You are not the owner of "${displayTable}".\n\nPossible solutions:\n1. Connect as the table owner (usually the user who created it)\n2. Ask the owner to run: ALTER TABLE "${displayTable}" OWNER TO your_username\n3. Use "Open SQL" to draft the query and send it to the DBA`;
  }

  if (message.includes("permission denied")) {
    return `Permission denied: ${message}\n\nThis is a database-level restriction, not an app issue.`;
  }

  if (message.includes("cannot insert multiple commands into a prepared statement")) {
    return `The database rejected multiple SQL statements in one request.\n\nRun them one by one, or use the SQL editor batch runner so each statement is sent separately.`;
  }

  if (message.includes("502") || message.includes("Bad Gateway") || message.includes("timeout")) {
    return `Connection timeout (HTTP 502): The database server took too long to respond.\n\nThis is often caused by:\n1. Supabase pooler being slow - try using port 5432 instead of 6543\n2. Query taking too long\n3. Network issues\n\nTry again or use a different connection port.`;
  }

  if (message.includes("connection refused") || message.includes("ECONNREFUSED")) {
    return `Connection refused: Cannot connect to the database server.\n\nPlease check:\n1. Is the server running?\n2. Is the host/port correct?\n3. Is your IP allowed in the database firewall?`;
  }

  if (message.includes("contains null values")) {
    return "Column still contains NULL values. Fill them before setting NOT NULL.";
  }

  return message;
}

function summarizeToastMessage(message: string, maxLength = 150) {
  const firstParagraph = message.split(/\n\s*\n/)[0]?.trim() || message.trim();
  const compact = firstParagraph.replace(/\s+/g, " ").trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

export function TableStructure({ connectionId, tableName, database, isActive = true }: Props) {
  const getTableStructure = useAppStore((state) => state.getTableStructure);
  const executeQuery = useAppStore((state) => state.executeQuery);
  const addTab = useAppStore((state) => state.addTab);
  const connections = useAppStore((state) => state.connections);

  const activeConnection = connections.find((connection) => connection.id === connectionId);
  const dbType = activeConnection?.db_type || "postgresql";
  const structureKey = `${connectionId}|${database || ""}|${tableName}`;
  const displayTableName = tableName.split(".").pop() || tableName;
  const canFastLoadColumns = dbType === "postgresql";

  const [columns, setColumns] = useState<ColumnDetail[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [hasLoadedMetadata, setHasLoadedMetadata] = useState(false);
  const [isLoadingColumns, setIsLoadingColumns] = useState(false);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<SectionKey>("columns");
  const [expandedSections, setExpandedSections] = useState<Set<SectionKey>>(DEFAULT_SECTION_STATE);
  const [columnEditor, setColumnEditor] = useState<ColumnEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [stagedColumnChanges, setStagedColumnChanges] = useState<Record<string, StagedColumnChange>>(
    {}
  );
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [isApplyingChanges, setIsApplyingChanges] = useState(false);
  const [toast, setToast] = useState<StructureToast | null>(null);

  const sectionRefs = useRef<Record<SectionKey, HTMLElement | null>>({
    columns: null,
    indexes: null,
    foreign_keys: null,
  });
  const mountedRef = useRef(true);
  const structureVersionRef = useRef(0);
  const columnsRequestIdRef = useRef(0);
  const metadataRequestIdRef = useRef(0);
  const toastIdRef = useRef(0);
  const toastHideTimeoutRef = useRef<number | null>(null);
  const toastClearTimeoutRef = useRef<number | null>(null);

  const stagedColumns = useMemo(
    () =>
      columns.map((column) => applyDraftToColumn(column, stagedColumnChanges[column.name]?.draft)),
    [columns, stagedColumnChanges]
  );
  const pendingChangeCount = Object.keys(stagedColumnChanges).length;
  const reviewStatements = useMemo(
    () => Object.values(stagedColumnChanges).flatMap((change) => change.statements),
    [stagedColumnChanges]
  );
  const editorOriginalColumn =
    columns.find((column) => column.name === columnEditor?.originalName) || null;
  const sqlPreview =
    columnEditor && editorOriginalColumn
      ? buildColumnAlterStatements(dbType, tableName, database, editorOriginalColumn, columnEditor)
      : { statements: [] };

  const setFromFullStructure = useCallback((structure: TableStructureType) => {
    setColumns(structure.columns);
    setIndexes(structure.indexes);
    setForeignKeys(structure.foreign_keys);
    setHasLoadedMetadata(true);
  }, []);

  const setFromColumns = useCallback((nextColumns: ColumnDetail[]) => {
    setColumns(nextColumns);
    setIndexes([]);
    setForeignKeys([]);
    setHasLoadedMetadata(false);
  }, []);

  const invalidateStructureCache = useCallback(() => {
    columnCache.delete(structureKey);
    fullStructureCache.delete(structureKey);
  }, [structureKey]);

  const clearToastTimers = useCallback(() => {
    if (toastHideTimeoutRef.current !== null) {
      window.clearTimeout(toastHideTimeoutRef.current);
      toastHideTimeoutRef.current = null;
    }

    if (toastClearTimeoutRef.current !== null) {
      window.clearTimeout(toastClearTimeoutRef.current);
      toastClearTimeoutRef.current = null;
    }
  }, []);

  const dismissToast = useCallback(() => {
    clearToastTimers();
    setToast((prev) => (prev ? { ...prev, isClosing: true } : prev));
    toastClearTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
      toastClearTimeoutRef.current = null;
    }, 220);
  }, [clearToastTimers]);

  const showToast = useCallback(
    (tone: StructureToastTone, title: string, description?: string) => {
      clearToastTimers();
      const toastId = ++toastIdRef.current;

      setToast({
        id: toastId,
        tone,
        title,
        description,
        isClosing: false,
      });

      toastHideTimeoutRef.current = window.setTimeout(() => {
        setToast((prev) => (prev?.id === toastId ? { ...prev, isClosing: true } : prev));
        toastHideTimeoutRef.current = null;
      }, 3200);

      toastClearTimeoutRef.current = window.setTimeout(() => {
        setToast((prev) => (prev?.id === toastId ? null : prev));
        toastClearTimeoutRef.current = null;
      }, 3440);
    },
    [clearToastTimers]
  );

  const loadColumns = useCallback(
    async (options: { force?: boolean } = {}) => {
      const viewVersion = structureVersionRef.current;
      const requestId = ++columnsRequestIdRef.current;

      if (!options.force) {
        const cachedFull = fullStructureCache.get(structureKey);
        if (cachedFull) {
          setFromFullStructure(cachedFull);
          setLoadError(null);
          return;
        }

        const cachedColumns = columnCache.get(structureKey);
        if (cachedColumns) {
          setFromColumns(cachedColumns);
          setLoadError(null);
          return;
        }
      }

      setIsLoadingColumns(true);
      setLoadError(null);

      try {
        if (canFastLoadColumns) {
          const { schema, name } = splitQualifiedTableName(tableName);
          const schemaLiteral = escapeSqlLiteral(schema);
          const tableLiteral = escapeSqlLiteral(name);
          const columnsQuery = `
            WITH target AS (
              SELECT c.oid AS relid
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = '${schemaLiteral}'
                AND c.relname = '${tableLiteral}'
              LIMIT 1
            )
            SELECT
              a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS is_nullable,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
              format_type(a.atttypid, a.atttypmod) AS column_type,
              EXISTS (
                SELECT 1
                FROM pg_constraint con
                WHERE con.conrelid = a.attrelid
                  AND con.contype = 'p'
                  AND a.attnum = ANY(con.conkey)
              ) AS is_primary_key
            FROM target t
            JOIN pg_attribute a ON a.attrelid = t.relid
            LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
            WHERE a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY a.attnum
          `;

          const result = await withTimeout(
            executeQuery(connectionId, columnsQuery),
            COLUMN_LOAD_TIMEOUT_MS,
            `Timed out loading columns for ${displayTableName}.`
          );

          if (
            !mountedRef.current ||
            viewVersion !== structureVersionRef.current ||
            requestId !== columnsRequestIdRef.current
          ) {
            return;
          }

          const nextColumns = result.rows.map((row) => ({
            name: asString(row[0]),
            data_type: asString(row[1]),
            is_nullable: asBoolean(row[2]),
            default_value: asNullableString(row[3]),
            column_type: asNullableString(row[4]),
            is_primary_key: asBoolean(row[5]),
            extra: undefined,
            comment: undefined,
          }));

          if (nextColumns.length === 0) {
            throw new Error(`No columns found for ${displayTableName}.`);
          }

          columnCache.set(structureKey, nextColumns);
          setFromColumns(nextColumns);
          return;
        }

        const result = await withTimeout(
          getTableStructure(connectionId, tableName, database),
          METADATA_LOAD_TIMEOUT_MS,
          `Timed out loading structure for ${displayTableName}.`
        );

        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== columnsRequestIdRef.current
        ) {
          return;
        }

        columnCache.set(structureKey, result.columns);
        fullStructureCache.set(structureKey, result);
        setFromFullStructure(result);
      } catch (error) {
        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== columnsRequestIdRef.current
        ) {
          return;
        }

        setLoadError(formatDbError(error, tableName));
        setColumns([]);
        setIndexes([]);
        setForeignKeys([]);
        setHasLoadedMetadata(false);
      } finally {
        if (
          mountedRef.current &&
          viewVersion === structureVersionRef.current &&
          requestId === columnsRequestIdRef.current
        ) {
          setIsLoadingColumns(false);
        }
      }
    },
    [
      canFastLoadColumns,
      connectionId,
      database,
      displayTableName,
      executeQuery,
      getTableStructure,
      setFromColumns,
      setFromFullStructure,
      structureKey,
      tableName,
    ]
  );

  const loadMetadata = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!canFastLoadColumns) return;
      if (!columns.length && !options.force) return;
      if (hasLoadedMetadata && !options.force) return;

      const viewVersion = structureVersionRef.current;
      const requestId = ++metadataRequestIdRef.current;
      setIsLoadingMetadata(true);
      setMetadataError(null);

      try {
        const result = await withTimeout(
          getTableStructure(connectionId, tableName, database),
          METADATA_LOAD_TIMEOUT_MS,
          `Timed out loading metadata for ${displayTableName}.`
        );

        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== metadataRequestIdRef.current
        ) {
          return;
        }

        columnCache.set(structureKey, result.columns);
        fullStructureCache.set(structureKey, result);
        setFromFullStructure(result);
      } catch (error) {
        if (
          !mountedRef.current ||
          viewVersion !== structureVersionRef.current ||
          requestId !== metadataRequestIdRef.current
        ) {
          return;
        }

        setMetadataError(formatDbError(error, tableName));
      } finally {
        if (
          mountedRef.current &&
          viewVersion === structureVersionRef.current &&
          requestId === metadataRequestIdRef.current
        ) {
          setIsLoadingMetadata(false);
        }
      }
    },
    [
      canFastLoadColumns,
      columns.length,
      connectionId,
      database,
      displayTableName,
      getTableStructure,
      hasLoadedMetadata,
      setFromFullStructure,
      structureKey,
      tableName,
    ]
  );

  const reloadStructure = useCallback(async () => {
    invalidateStructureCache();
    columnsRequestIdRef.current += 1;
    metadataRequestIdRef.current += 1;
    setColumns([]);
    setIndexes([]);
    setForeignKeys([]);
    setHasLoadedMetadata(false);
    setMetadataError(null);
    await loadColumns({ force: true });
  }, [invalidateStructureCache, loadColumns]);

  const countNullValues = useCallback(
    async (columnName: string) => {
      const tableRef = qualifyTableName(dbType, tableName, database);
      const columnRef = quoteIdentifier(dbType, columnName);
      const sql = `SELECT COUNT(*) AS count FROM ${tableRef} WHERE ${columnRef} IS NULL`;
      const result = await executeQuery(connectionId, sql);
      const value = result.rows[0]?.[0];
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    [connectionId, database, dbType, executeQuery, tableName]
  );

  const scrollToSection = (section: SectionKey) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        sectionRefs.current[section]?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    });
  };

  const closeColumnEditor = useCallback(() => {
    if (isApplyingChanges) return;
    setEditorError(null);
    setColumnEditor(null);
  }, [isApplyingChanges]);

  const focusSection = useCallback(
    (section: SectionKey) => {
      setActiveSection(section);
      setExpandedSections((prev) => {
        if (prev.has(section)) return prev;
        const next = new Set(prev);
        next.add(section);
        return next;
      });

      if (section !== "columns" && !hasLoadedMetadata && !isLoadingMetadata) {
        void loadMetadata();
      }

      scrollToSection(section);
    },
    [hasLoadedMetadata, isLoadingMetadata, loadMetadata]
  );

  const toggleSection = (section: SectionKey) => {
    setActiveSection(section);
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });

    if (section !== "columns" && !hasLoadedMetadata && !isLoadingMetadata) {
      void loadMetadata();
    }
  };

  const openColumnEditor = (column: ColumnDetail) => {
    setEditorError(null);
    setColumnEditor(createEditorState(column, stagedColumnChanges[column.name]?.draft));
    focusSection("columns");
  };

  const stageColumnChange = () => {
    if (!columnEditor || !editorOriginalColumn) return;

    if (sqlPreview.error) {
      setEditorError(sqlPreview.error);
      showToast("error", "Cannot stage change", sqlPreview.error);
      return;
    }

    if (sqlPreview.statements.length === 0) {
      setEditorError("No changes to stage.");
      showToast("info", "No changes detected", "Edit at least one field before staging.");
      return;
    }

    setStagedColumnChanges((prev) => ({
      ...prev,
      [editorOriginalColumn.name]: {
        original: editorOriginalColumn,
        draft: { ...columnEditor },
        statements: [...sqlPreview.statements],
      },
    }));
    setEditorError(null);
    setColumnEditor(null);
    showToast("success", "Change staged", `${editorOriginalColumn.name} is ready for review.`);
  };

  const discardStagedChanges = () => {
    setStagedColumnChanges({});
    setReviewError(null);
  };

  const openColumnSqlDraft = () => {
    if (!columnEditor || sqlPreview.error || sqlPreview.statements.length === 0) return;

    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: `Alter ${columnEditor.name.trim() || columnEditor.originalName}`,
      connectionId,
      database,
      content: `${sqlPreview.statements.join(";\n")};`,
    });
  };

  const openReviewSqlDraft = () => {
    if (reviewStatements.length === 0) {
      showToast("info", "No staged SQL", "Stage a change first, then open the generated SQL.");
      return;
    }

    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: `Alter ${displayTableName}`,
      connectionId,
      database,
      content: `${reviewStatements.join(";\n")};`,
    });
  };

  const applyStagedChanges = async () => {
    if (pendingChangeCount === 0) {
      showToast("info", "Nothing to apply", "There are no staged structure changes yet.");
      return;
    }

    setReviewError(null);
    setIsApplyingChanges(true);
    const appliedChangeCount = pendingChangeCount;

    try {
      for (const change of Object.values(stagedColumnChanges)) {
        const shouldSetNotNull = !change.draft.nullable && change.original.is_nullable;

        if (shouldSetNotNull) {
          const nullCount = await countNullValues(change.original.name);
          if (nullCount > 0) {
            const defaultValue = getDefaultValueForType(change.draft.dataType);
            const confirmed = window.confirm(
              `Column "${change.original.name}" has ${nullCount} NULL value(s).\n\n` +
                `To set NOT NULL, the app can update them to ${defaultValue} first.\n\n` +
                `Click OK to continue, or Cancel to stop.`
            );

            if (!confirmed) {
              throw new Error("Apply cancelled.");
            }

            const tableRef = qualifyTableName(dbType, tableName, database);
            const columnRef = quoteIdentifier(dbType, change.original.name);
            const fixSql = `UPDATE ${tableRef} SET ${columnRef} = ${defaultValue} WHERE ${columnRef} IS NULL`;
            await executeQuery(connectionId, fixSql);
          }
        }

        for (const statement of change.statements) {
          await executeQuery(connectionId, statement);
        }
      }

      discardStagedChanges();
      setIsReviewOpen(false);
      await reloadStructure();
      showToast(
        "success",
        "Structure updated",
        `${appliedChangeCount} change${appliedChangeCount === 1 ? "" : "s"} applied to ${displayTableName}.`
      );
    } catch (error) {
      const formattedError = formatDbError(error, tableName);
      if (formattedError === "Apply cancelled.") {
        showToast("info", "Apply cancelled", "No structure changes were sent to the database.");
      } else {
        setReviewError(formattedError);
        showToast("error", "Could not update structure", summarizeToastMessage(formattedError));
      }
    } finally {
      if (mountedRef.current) {
        setIsApplyingChanges(false);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      columnsRequestIdRef.current += 1;
      metadataRequestIdRef.current += 1;
      clearToastTimers();
    };
  }, [clearToastTimers]);

  useEffect(() => {
    structureVersionRef.current += 1;
    columnsRequestIdRef.current += 1;
    metadataRequestIdRef.current += 1;

    const cachedFull = fullStructureCache.get(structureKey);
    const cachedColumns = columnCache.get(structureKey);

    if (cachedFull) {
      setFromFullStructure(cachedFull);
    } else if (cachedColumns) {
      setFromColumns(cachedColumns);
    } else {
      setColumns([]);
      setIndexes([]);
      setForeignKeys([]);
      setHasLoadedMetadata(false);
    }

    setLoadError(null);
    setMetadataError(null);
    setIsLoadingColumns(false);
    setIsLoadingMetadata(false);
    setActiveSection("columns");
    setExpandedSections(new Set(DEFAULT_SECTION_STATE));
    setColumnEditor(null);
    setEditorError(null);
    setStagedColumnChanges({});
    setIsReviewOpen(false);
    setReviewError(null);
  }, [setFromColumns, setFromFullStructure, structureKey]);

  useEffect(() => {
    if (!isActive) return;
    if (columns.length > 0 || isLoadingColumns) return;
    if (loadError) return;
    void loadColumns();
  }, [columns.length, isActive, isLoadingColumns, loadError, loadColumns]);

  useEffect(() => {
    if (!isActive) return;
    if (hasLoadedMetadata || isLoadingMetadata) return;
    if (
      activeSection === "columns" &&
      !expandedSections.has("indexes") &&
      !expandedSections.has("foreign_keys")
    ) {
      return;
    }
    void loadMetadata();
  }, [
    activeSection,
    expandedSections,
    hasLoadedMetadata,
    isActive,
    isLoadingMetadata,
    loadMetadata,
  ]);

  useEffect(() => {
    if (!columnEditor) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeColumnEditor();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeColumnEditor, columnEditor]);

  if (isLoadingColumns && columns.length === 0) {
    return (
      <div className="structure-state">
        <div className="structure-state-card">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
          <span>Loading columns...</span>
        </div>
      </div>
    );
  }

  if (!columns.length) {
    return (
      <div className="structure-state">
        <div className="structure-state-card error">
          <span>{loadError || "Failed to load structure"}</span>
          <button type="button" className="btn btn-secondary" onClick={() => void reloadStructure()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="structure-shell">
        <div className="structure-topbar">
          <div className="structure-topbar-copy">
            <span className="structure-topbar-kicker">Table Structure</span>
            <div className="structure-topbar-title-row">
              <Columns3 className="w-4 h-4 text-[var(--accent-hover)]" />
              <h3 className="structure-topbar-title">{displayTableName}</h3>
            </div>
            <p className="structure-topbar-subtitle">
              Columns load first. Indexes and foreign keys load when you open those sections.
            </p>
          </div>

          <div className="structure-topbar-side">
            {pendingChangeCount > 0 && (
              <div className="structure-topbar-actions">
                <span className="structure-pending-pill">{pendingChangeCount} pending</span>
                <button type="button" className="btn btn-secondary" onClick={() => setIsReviewOpen(true)}>
                  Review SQL
                </button>
                <button type="button" className="btn btn-secondary" onClick={discardStagedChanges}>
                  Discard
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void applyStagedChanges()}>
                  {isApplyingChanges ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  <span>Apply</span>
                </button>
              </div>
            )}

            <div className="structure-topbar-stats">
              <button
                type="button"
                className={`structure-stat-pill ${activeSection === "columns" ? "active" : ""}`}
                onClick={() => focusSection("columns")}
              >
                {columns.length} columns
              </button>
              <button
                type="button"
                className={`structure-stat-pill ${activeSection === "indexes" ? "active" : ""}`}
                onClick={() => focusSection("indexes")}
              >
                {hasLoadedMetadata ? `${indexes.length} indexes` : "Load indexes"}
              </button>
              <button
                type="button"
                className={`structure-stat-pill ${activeSection === "foreign_keys" ? "active" : ""}`}
                onClick={() => focusSection("foreign_keys")}
              >
                {hasLoadedMetadata ? `${foreignKeys.length} foreign keys` : "Load foreign keys"}
              </button>
            </div>
          </div>
        </div>

        <div className="structure-sections">
          <section
            ref={(node) => {
              sectionRefs.current.columns = node;
            }}
            className={`structure-section ${activeSection === "columns" ? "active" : ""}`}
          >
            <button
              type="button"
              onClick={() => toggleSection("columns")}
              className="structure-section-toggle"
              aria-expanded={expandedSections.has("columns")}
            >
              <div className="structure-section-head">
                {expandedSections.has("columns") ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                <div className="structure-section-icon">
                  <Columns3 className="w-4 h-4" />
                </div>
                <div className="structure-section-copy">
                  <span className="structure-section-title">Columns</span>
                  <span className="structure-section-subtitle">
                    Edit in memory first, then review SQL before applying.
                  </span>
                </div>
              </div>
              <span className="structure-section-count">{columns.length}</span>
            </button>

            {expandedSections.has("columns") && (
              <div className="structure-section-body">
                <table className="structure-table">
                  <thead>
                    <tr>
                      <th className="structure-th">Column</th>
                      <th className="structure-th">Type</th>
                      <th className="structure-th">Nullable</th>
                      <th className="structure-th">Default</th>
                      <th className="structure-th">Extra</th>
                      <th className="structure-th structure-th-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((column, index) => {
                      const draft = stagedColumnChanges[column.name]?.draft;
                      const displayColumn = stagedColumns[index];
                      return (
                        <tr
                          key={column.name}
                          className={`structure-row ${index % 2 !== 0 ? "alt" : ""} ${draft ? "staged" : ""}`}
                        >
                          <td className="structure-td">
                            <div className="structure-name-cell">
                              {displayColumn.is_primary_key && (
                                <Key className="w-3.5 h-3.5 text-[var(--warning)]" />
                              )}
                              <span className="structure-name-text">{displayColumn.name}</span>
                              {displayColumn.is_primary_key && (
                                <span className="structure-inline-pill primary">PK</span>
                              )}
                              {draft && <span className="structure-inline-pill staged">Edited</span>}
                            </div>
                          </td>
                          <td className="structure-td">
                            <span className="structure-inline-pill type">
                              {displayColumn.column_type || displayColumn.data_type}
                            </span>
                          </td>
                          <td className="structure-td">
                            <span
                              className={`structure-inline-pill ${displayColumn.is_nullable ? "" : "strong"}`}
                            >
                              {displayColumn.is_nullable ? "YES" : "NO"}
                            </span>
                          </td>
                          <td className="structure-td">
                            <span
                              className="structure-code-chip"
                              title={displayColumn.default_value || "-"}
                            >
                              {displayColumn.default_value || "-"}
                            </span>
                          </td>
                          <td className="structure-td">
                            <span className="structure-code-chip" title={displayColumn.extra || "-"}>
                              {displayColumn.extra || "-"}
                            </span>
                          </td>
                          <td className="structure-td structure-td-actions">
                            <div className="structure-action-group">
                              <button
                                type="button"
                                className="structure-action-btn"
                                onClick={() => openColumnEditor(column)}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                                <span>Edit</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section
            ref={(node) => {
              sectionRefs.current.indexes = node;
            }}
            className={`structure-section ${activeSection === "indexes" ? "active" : ""}`}
          >
            <button
              type="button"
              onClick={() => toggleSection("indexes")}
              className="structure-section-toggle"
              aria-expanded={expandedSections.has("indexes")}
            >
              <div className="structure-section-head">
                {expandedSections.has("indexes") ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
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

            {expandedSections.has("indexes") && (
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
                          onClick={() => void loadMetadata({ force: true })}
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

          <section
            ref={(node) => {
              sectionRefs.current.foreign_keys = node;
            }}
            className={`structure-section ${activeSection === "foreign_keys" ? "active" : ""}`}
          >
            <button
              type="button"
              onClick={() => toggleSection("foreign_keys")}
              className="structure-section-toggle"
              aria-expanded={expandedSections.has("foreign_keys")}
            >
              <div className="structure-section-head">
                {expandedSections.has("foreign_keys") ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
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

            {expandedSections.has("foreign_keys") && (
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
                          onClick={() => void loadMetadata({ force: true })}
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
                                <Link className="w-3.5 h-3.5" />
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
        </div>
      </div>

      {columnEditor && (
        <div className="structure-editor-overlay" onClick={closeColumnEditor}>
          <div className="structure-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="structure-editor-header">
              <div className="structure-editor-copy">
                <span className="structure-topbar-kicker">Column Action</span>
                <h3 className="structure-editor-title">Edit {columnEditor.originalName}</h3>
                <p className="structure-editor-subtitle">
                  Stage the change first, then review the generated SQL before applying.
                </p>
              </div>

              <button
                type="button"
                className="structure-editor-close"
                onClick={closeColumnEditor}
                aria-label="Close column editor"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="structure-editor-grid">
              <label className="structure-editor-field">
                <span className="form-label">Column Name</span>
                <input
                  className="input"
                  value={columnEditor.name}
                  onChange={(event) => {
                    setEditorError(null);
                    setColumnEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev));
                  }}
                />
              </label>

              <label className="structure-editor-field">
                <span className="form-label">Type</span>
                <input
                  className="input"
                  value={columnEditor.dataType}
                  onChange={(event) => {
                    setEditorError(null);
                    setColumnEditor((prev) =>
                      prev ? { ...prev, dataType: event.target.value } : prev
                    );
                  }}
                />
              </label>

              <label className="structure-editor-field">
                <span className="form-label">Nullable</span>
                <button
                  type="button"
                  className={`structure-toggle ${columnEditor.nullable ? "on" : ""}`}
                  disabled={columnEditor.isPrimaryKey}
                  onClick={() => {
                    setEditorError(null);
                    setColumnEditor((prev) => (prev ? { ...prev, nullable: !prev.nullable } : prev));
                  }}
                >
                  <span className="structure-toggle-track">
                    <span className="structure-toggle-thumb" />
                  </span>
                  <span className="structure-toggle-copy">
                    {columnEditor.isPrimaryKey
                      ? "Primary keys stay NOT NULL"
                      : columnEditor.nullable
                        ? "Allows NULL"
                        : "Requires a value"}
                  </span>
                </button>
              </label>

              <div className="structure-editor-field structure-editor-field-wide">
                <span className="form-label">Default Behavior</span>
                <div className="structure-mode-group">
                  {(["keep", "set", "drop"] as DefaultMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`structure-mode-btn ${columnEditor.defaultMode === mode ? "active" : ""}`}
                      onClick={() => {
                        setEditorError(null);
                        setColumnEditor((prev) => (prev ? { ...prev, defaultMode: mode } : prev));
                      }}
                    >
                      {mode === "keep"
                        ? "Keep current"
                        : mode === "set"
                          ? "Set new default"
                          : "Drop default"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="structure-editor-field structure-editor-field-wide">
                <span className="form-label">Default SQL Expression</span>
                <input
                  className="input"
                  value={columnEditor.defaultValue}
                  disabled={columnEditor.defaultMode !== "set"}
                  placeholder="'value', CURRENT_TIMESTAMP, gen_random_uuid()"
                  onChange={(event) => {
                    setEditorError(null);
                    setColumnEditor((prev) =>
                      prev ? { ...prev, defaultValue: event.target.value } : prev
                    );
                  }}
                />
                <span className="structure-editor-hint">
                  Enter raw SQL. For strings, wrap the value in single quotes.
                </span>
              </label>
            </div>

            <div className="structure-editor-preview-shell">
              <div className="structure-editor-preview-head">
                <span className="form-label">SQL Preview</span>
                <span className={`structure-editor-db-pill ${dbType === "sqlite" ? "muted" : ""}`}>
                  {dbType.toUpperCase()}
                </span>
              </div>
              <pre className="structure-editor-preview">
                {sqlPreview.error
                  ? sqlPreview.error
                  : sqlPreview.statements.length > 0
                    ? `${sqlPreview.statements.join(";\n")};`
                    : "Change a field above to generate ALTER TABLE SQL."}
              </pre>
            </div>

            {editorError && (
              <div className="structure-editor-alert">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{editorError}</span>
              </div>
            )}

            <div className="structure-editor-footer">
              <button type="button" className="btn btn-secondary" onClick={closeColumnEditor}>
                Cancel
              </button>

              <div className="structure-editor-footer-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={openColumnSqlDraft}
                  disabled={!!sqlPreview.error || sqlPreview.statements.length === 0}
                >
                  <FileCode className="w-4 h-4" />
                  <span>Open SQL</span>
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={stageColumnChange}
                  disabled={!!sqlPreview.error || sqlPreview.statements.length === 0}
                >
                  <Check className="w-4 h-4" />
                  <span>Stage Change</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isReviewOpen && (
        <div className="structure-editor-overlay" onClick={() => setIsReviewOpen(false)}>
          <div className="structure-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="structure-editor-header">
              <div className="structure-editor-copy">
                <span className="structure-topbar-kicker">Schema Review</span>
                <h3 className="structure-editor-title">Review staged SQL</h3>
                <p className="structure-editor-subtitle">
                  Preview every statement before it changes the table.
                </p>
              </div>

              <button
                type="button"
                className="structure-editor-close"
                onClick={() => setIsReviewOpen(false)}
                aria-label="Close SQL review"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="structure-review-list">
              {Object.values(stagedColumnChanges).map((change) => (
                <div key={change.original.name} className="structure-review-card">
                  <div className="structure-review-head">
                    <span className="structure-review-title">
                      {change.original.name} -&gt; {change.draft.name}
                    </span>
                    <span className="structure-inline-pill staged">Column change</span>
                  </div>
                  <pre className="structure-editor-preview">{`${change.statements.join(";\n")};`}</pre>
                </div>
              ))}
            </div>

            {reviewError && (
              <div className="structure-editor-alert">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{reviewError}</span>
              </div>
            )}

            <div className="structure-editor-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setIsReviewOpen(false)}>
                Close
              </button>

              <div className="structure-editor-footer-actions">
                <button type="button" className="btn btn-secondary" onClick={discardStagedChanges}>
                  Discard
                </button>
                <button type="button" className="btn btn-secondary" onClick={openReviewSqlDraft}>
                  <FileCode className="w-4 h-4" />
                  <span>Open SQL</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void applyStagedChanges()}
                  disabled={isApplyingChanges || pendingChangeCount === 0}
                >
                  {isApplyingChanges ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  <span>Apply</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`structure-toast ${toast.tone} ${toast.isClosing ? "closing" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className={`structure-toast-icon ${toast.tone}`}>
            {toast.tone === "success" ? (
              <Check className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
          </div>

          <div className="structure-toast-copy">
            <span className="structure-toast-title">{toast.title}</span>
            {toast.description && (
              <span className="structure-toast-description">{toast.description}</span>
            )}
          </div>

          <button
            type="button"
            className="structure-toast-close"
            onClick={dismissToast}
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
}
