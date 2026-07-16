import type { AIResponseLanguage } from "../../types";
import { MAX_TABLE_NAMES_IN_CONTEXT } from "./AISlidePanelUtils";
import type { AgentTraceStep, AssistIntent } from "./ai-agent-context";
import type { AIWorkspaceInteractionMode } from "./ai-workspace-types";

export function buildAgentEvidenceSummary(steps: AgentTraceStep[]) {
  if (steps.length === 0) {
    return "No verified tool observations were captured.";
  }

  return steps.map((step) => [
    `Step ${step.step}`,
    `Action: ${step.action}`,
    `Reason: ${step.message || "No message provided."}`,
    "Observation:",
    step.observation,
  ].join("\n")).join("\n\n");
}

export function buildAgentFinalRecoveryPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  evidenceSummary: string;
  wantsVisualization: boolean;
  reason: string;
}) {
  const {
    userPrompt,
    assistIntent,
    currentDatabase,
    availableTableNames,
    evidenceSummary,
    wantsVisualization,
    reason,
  } = params;
  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);

  return [
    "Write the final user-facing answer now.",
    "Do not return JSON.",
    "Do not ask for more tool calls.",
    "Use only the verified schema and observations already collected.",
    `Current database: ${currentDatabase || "Default"}.`,
    visibleTables.length > 0
      ? `Allowed tables: ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}.`
      : "Allowed tables: use only the verified evidence already captured.",
    `Recovery reason: ${reason}.`,
    assistIntent === "overview"
      ? "Provide a grounded database overview."
      : "Answer the user's request directly and concisely.",
    wantsVisualization
      ? "The user wants a chart or visualization. Recommend one chart type and, when enough evidence exists, include one chart-friendly SQL query that returns a label column plus one or more numeric metric columns. Mention that after running the SQL the user can switch the result to Chart view."
      : "",
    "If you include SQL, put it in a single ```sql fenced block.",
    "",
    "User request:",
    userPrompt,
    "",
    "Verified observations:",
    evidenceSummary,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildLocalAgentFallbackResponse(params: {
  language: AIResponseLanguage;
  currentDatabase: string | null;
  availableTableNames: string[];
  wantsVisualization: boolean;
  steps: AgentTraceStep[];
}) {
  const {
    language,
    currentDatabase,
    availableTableNames,
    wantsVisualization,
    steps,
  } = params;
  const tablePreview = availableTableNames.slice(0, 8).join(", ");
  const lastStep = steps[steps.length - 1];
  const lastStepLabel = lastStep ? `${lastStep.action}` : "";
  const hasMoreTables = availableTableNames.length > 8;

  if (language === "vi") {
    return [
      `Mình đã thu thập được evidence có kiểm chứng từ DB "${currentDatabase || "Default"}", nhưng agent chưa kịp tự chốt câu trả lời cuối.`,
      tablePreview ? `Các bảng đã xác minh: ${tablePreview}${hasMoreTables ? ", ..." : ""}.` : "",
      lastStepLabel ? `Bước gần nhất của agent: ${lastStepLabel}.` : "",
      wantsVisualization
        ? "Thử lại một lần nữa là được; mình sẽ ưu tiên câu trả lời có kèm SQL dạng chart-friendly để bạn chạy xong chuyển sang Chart view."
        : "Thử lại một lần nữa là được; agent sẽ tổng hợp nốt câu trả lời từ evidence hiện có.",
    ].filter(Boolean).join("\n\n");
  }

  if (language === "zh") {
    return [
      `我已经从数据库“${currentDatabase || "Default"}”收集到经过验证的证据，但 agent 还没来得及整理成最终答复。`,
      tablePreview ? `已验证的表：${tablePreview}${hasMoreTables ? ", ..." : ""}。` : "",
      lastStepLabel ? `agent 最近一步：${lastStepLabel}。` : "",
      wantsVisualization
        ? "再试一次即可；我会优先返回适合切换到 Chart view 的图表型 SQL。"
        : "再试一次即可；agent 会基于这些证据完成最终总结。",
    ].filter(Boolean).join("\n\n");
  }

  return [
    `The agent gathered verified evidence from database "${currentDatabase || "Default"}" but did not finish composing the final answer in time.`,
    tablePreview ? `Verified tables: ${tablePreview}${hasMoreTables ? ", ..." : ""}.` : "",
    lastStepLabel ? `Last agent step: ${lastStepLabel}.` : "",
    wantsVisualization
      ? "Try again and the agent will prioritize a chart-friendly SQL result that can be switched into Chart view."
      : "Try again so the agent can synthesize the verified evidence into a final response.",
  ].filter(Boolean).join("\n\n");
}

export function buildAssistPrompt(
  prompt: string,
  intent: AssistIntent,
  interactionMode: AIWorkspaceInteractionMode,
) {
  const schemaCapsuleInstruction =
    "When database context is attached, it may arrive as a compact schema capsule / codec. Treat that capsule as the source of truth.";
  const interactionInstruction =
    interactionMode === "agent"
      ? intent === "general"
        ? "Interaction mode: agent. Act like a capable general-purpose assistant. Answer directly unless the user explicitly needs grounded workspace evidence or SQL."
        : "Interaction mode: agent. Prefer execution-ready SQL when the user asks for SQL, but never assume it will run without explicit approval."
      : interactionMode === "edit"
        ? intent === "general"
          ? "Interaction mode: edit. Prefer structured drafts, rewrites, and reviewable changes that a human can inspect."
          : "Interaction mode: edit. Prefer reviewable SQL, safer rewrites, and change plans that a human can inspect before running."
        : intent === "general"
          ? "Interaction mode: prompt-only. Answer directly from the user's words. You can help with writing, planning, coding, and general reasoning."
          : "Interaction mode: prompt-only. Work from the user's words only and treat any SQL as draft guidance instead of an autonomous action.";

  if (intent === "general") {
    return [
      interactionInstruction,
      "User intent: help with a general-purpose request.",
      "You are a capable assistant inside a database workspace, but you are not limited to database-only tasks.",
      "Help with writing, planning, coding, summarization, translation, brainstorming, and everyday questions naturally.",
      "Use the provided workspace or database context only when it is relevant to the user's request.",
      "Do not pretend the request is about SQL or schema when it is broader than that.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "overview") {
    return [
      interactionInstruction,
      "User intent: review the current database and provide a grounded overview of the actual schema context.",
      schemaCapsuleInstruction,
      "Read the provided database context first.",
      "Summarize the actual tables, their likely roles, and the key relationships you can infer.",
      "Do not explain generic database theory unless the user explicitly asks for theory.",
      "Do not generate SQL unless the user explicitly asks for SQL.",
      "If the schema context is incomplete, say what is missing instead of guessing.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "explain") {
    return [
      interactionInstruction,
      "User intent: explain the schema, columns, or behavior in plain language.",
      schemaCapsuleInstruction,
      "Ground the answer in the provided database context when it exists.",
      "Avoid generic textbook definitions if the schema context already shows the concrete tables or columns being discussed.",
      "Do not generate SQL unless the user explicitly asks for a query, statement, or schema change.",
      "Prefer explanation, examples, tradeoffs, and suggestions over code.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "optimize") {
    return [
      interactionInstruction,
      "User intent: optimize the given SQL query for better performance.",
      schemaCapsuleInstruction,
      "Analyze the query for potential performance issues: missing indexes, inefficient joins, full table scans, unnecessary subqueries, etc.",
      "Ground the answer in the provided database context (schema, indexes, foreign keys) when available.",
      "Return the optimized SQL inside a single ```sql fenced block.",
      "Outside the code block, briefly explain: what changed, why it is faster, and any tradeoffs or risks.",
      "Do not change the query semantics — the result must be functionally identical.",
      "If the query is already optimal, say so and explain why.",
      "",
      prompt,
    ].join("\n");
  }

  if (intent === "fix-error") {
    return [
      interactionInstruction,
      "User intent: fix the SQL error or bug in the provided query.",
      schemaCapsuleInstruction,
      "If the user provides an error message, diagnose it and rewrite the corrected SQL.",
      "If no explicit error is given, look for common SQL mistakes: syntax errors, type mismatches, invalid column references, NULL handling issues, etc.",
      "Ground the fix in the provided database schema context when available.",
      "Return the corrected SQL inside a single ```sql fenced block.",
      "Outside the code block, briefly explain: what was wrong and what was changed.",
      "Do not change the query semantics unless the original was incorrect.",
      "",
      prompt,
    ].join("\n");
  }

  return [
    interactionInstruction,
    "User intent: produce runnable SQL grounded in the provided database context.",
    schemaCapsuleInstruction,
    "Use only tables and columns that exist in the provided schema context.",
    "Do not invent tables, columns, keys, or relationships.",
    "Prefer safe read-only SELECT statements unless the user explicitly asks for data changes or schema changes.",
    "If the user asks which tables are related, what key they share, or asks for a sample to run, infer that only from visible foreign keys, indexes, and matching *_id columns that actually exist in the provided schema context.",
    "If one statement is not enough, you may return a short sequence of runnable SQL statements separated by semicolons.",
    "Return the runnable SQL inside a single ```sql fenced block and keep any explanation outside that block.",
    "",
    prompt,
  ].join("\n");
}

export function buildAgentTraceMarkdown(steps: AgentTraceStep[]) {
  if (steps.length === 0) {
    return "";
  }

  return [
    "## Agent Trace",
    ...steps.map((step) => [
      `### Step ${step.step}: \`${step.action}\``,
      step.message || "No message provided.",
      "```text",
      step.observation,
      "```",
    ].join("\n")),
  ].join("\n\n");
}
