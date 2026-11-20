import type {
  AIConversationMessage,
  AIProviderConfig,
  AIRequestAttachment,
  AIRequestIntent,
  AIRequestMode,
  DatabaseType,
  TableInfo,
} from "../../../types";
import type { AIAttachmentDraft } from "../../../utils/ai-attachments";
import type { AIAgentTurnResult, AskAIOptions } from "../../../stores/aiStore";
import type { useConnectionStore } from "../../../stores/connectionStore";
import type { useQueryStore } from "../../../stores/queryStore";
import type { AgentToolAvailability } from "../ai-agent-engine-gates";
import type {
  AIWorkspaceAgentAutonomy,
  AIWorkspaceAgentStep,
  AIWorkspaceInteractionMode,
  AIWorkspaceRunTraceEntry,
} from "../ai-workspace-types";

/** Narrow input for opening a table query tab — the store's own tab shape is
 *  deliberately not part of the engine contract, so the store can evolve
 *  without touching the engine. */
export interface OpenQueryTabInput {
  id: string;
  type: "table";
  title: string;
  connectionId: string;
  tableName: string;
  database?: string;
}

/** Pure mutable value box compatible with React's `MutableRefObject<T>` without importing React. */
export interface MutableValueBox<T> {
  current: T;
}

export type AskAI = (
  prompt: string,
  context: string,
  mode?: AIRequestMode,
  intent?: AIRequestIntent,
  history?: AIConversationMessage[],
  attachments?: AIRequestAttachment[],
  options?: AskAIOptions,
) => Promise<string>;

export type AskAIAgentTurn = (
  prompt: string,
  context: string,
  history?: AIConversationMessage[],
  attachments?: AIRequestAttachment[],
  options?: AskAIOptions,
) => Promise<AIAgentTurnResult>;

export interface AgentAssistContext {
  activeDbType: DatabaseType | undefined;
  activeProvider: AIProviderConfig | null | undefined;
  askAI: AskAI;
  /** Optional native multi-turn transport; defaults to `useAIStore.getState().askAIAgentTurn` or wraps `askAI`. */
  askAIAgentTurn?: AskAIAgentTurn;
  cancelAIRequest: () => Promise<unknown>;
  connectionId: string | null;
  currentDatabase: string | null;
  executeAgentParameterizedQuery: ReturnType<
    typeof useQueryStore.getState
  >["executeAgentParameterizedQuery"];
  executeAgentReadonlyQuery: ReturnType<typeof useQueryStore.getState>["executeAgentReadonlyQuery"];
  executeSandboxQuery: ReturnType<typeof useQueryStore.getState>["executeSandboxQuery"];
  fetchTables: ReturnType<typeof useConnectionStore.getState>["fetchTables"];
  getTableColumnsPreview: ReturnType<typeof useQueryStore.getState>["getTableColumnsPreview"];
  getTableData: ReturnType<typeof useQueryStore.getState>["getTableData"];
  getTableStructure: ReturnType<typeof useQueryStore.getState>["getTableStructure"];
  isLocalProvider: boolean;
  listCheckpoints: (connectionId: string) => Promise<
    Array<{
      fileName: string;
      label: string;
      createdAt: number;
      engine: string;
      database: string | null;
      tableCount: number;
      rowCount: number;
      sizeBytes: number;
    }>
  >;
  previewWriteTransaction: ReturnType<typeof useQueryStore.getState>["previewWriteTransaction"];
  restoreCheckpoint: (connectionId: string, fileName: string, dbType: string) => Promise<unknown>;
  setError: (message: string | null) => void;
  setIsGenerating: (generating: boolean) => void;
  requestIdRef: MutableValueBox<number>;
  lastReasoningRef: MutableValueBox<string | undefined>;
  lastModelUsedRef: MutableValueBox<string | undefined>;
  aiSchemaCodecCacheRef: MutableValueBox<Map<string, string>>;
  /** Autonomy for the bound connection — routed through the factory instead of
   *  `useAIAutonomyStore.getState()` (DI-contract cleanup, 2026-11-20). */
  getAutonomyForConnection: (connectionId: string) => AIWorkspaceAgentAutonomy;
  /** Current tabs as { id, type } pairs (not the full store Tab shape) — lets
   *  the driver keep its type filters while never touching the store. */
  listTabs: () => Array<{ id: string; type: string }>;
  /** Open a table query tab; the driver computes "was a new tab created" by
   *  diffing listTabIds() before/after. */
  openQueryTab: (input: OpenQueryTabInput) => void;
  /** The bound connection's engine kind — the only field the driver reads from
   *  connection state (was a whole-store read at turn-driver :434). */
  getDbTypeForConnection: (connectionId: string | null) => DatabaseType | undefined;
  /** Provider lifecycle: in-flight request id, provider list, and provider
   *  restore after a cross-provider run. */
  getActiveAIRequestId: () => string | null;
  getAIConfigs: () => AIProviderConfig[];
  restoreProvider: (providerId: string) => void;
}

export interface AgentAssistOptions {
  interactionMode?: AIWorkspaceInteractionMode;
  requestDataReadConsent?: () => Promise<boolean>;
  /** Per-call destructive confirmation — always dialogs, never standing. */
  requestDataDestructiveConsent?: (detail: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  userPrompt?: string;
  onAgentProgress?: (steps: AIWorkspaceAgentStep[], runTrace?: AIWorkspaceRunTraceEntry[]) => void;
  /** Files/images attached by the user for this turn (composer pipeline). */
  attachments?: AIAttachmentDraft[];
  /**
   * P10: this run was started by a scheduled agent task. Confined to the
   * read-only tool surface across request catalog, prompt, and executor.
   */
  unattendedReadOnly?: boolean;
  /** File command's `allowed-tools:` narrowing for this run only. */
  commandToolRestriction?: string[];
}

export interface LoadedAgentWorkspaceContext {
  latestTables: TableInfo[];
  agentPromptTableNames: string[];
  availableSchemaTables: string[];
  context: string;
  relationalSchemaSummaryByTable: Map<string, string>;
  strictRecoveryContext: string | null;
  workspaceToolsEnabled: boolean;
  toolAvailability: AgentToolAvailability;
  recordLookupRequest: boolean;
  workspaceToolStatus: string;
  sharedAgentInstruction: string;
  cachedTableSummaries?: string[];
  glossaryLines?: string[];
  availableSkills?: { name: string; description: string }[];
  agentMemoryIndex?: { name: string; description: string; updatedAt: string }[] | null;
  queryTabs?: { tabId: string; title: string; sql: string }[];
  workspaceBoundDatabase: string | null;
  knownDatabaseNames: string[];
  agentStepBudget: number;
}
