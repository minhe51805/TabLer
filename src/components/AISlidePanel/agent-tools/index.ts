/**
 * Agent tool registry: name → handler. The executor
 * (ai-agent-tool-executor.ts) applies the run-level guards and bookkeeping,
 * then dispatches each call through this map. Tool schemas live in
 * tool-schema/specs.ts; this map only wires runtime behavior.
 */
import { tool as checkSql } from "./check-sql";
import { tools as checkpoints } from "./checkpoints";
import { tool as delegate } from "./delegate";
import { tools as describeTable } from "./describe-table";
import { tool as editQuerySql } from "./edit-query-sql";
import { tool as findValue } from "./find-value";
import { tool as listSchemaObjects } from "./list-schema-objects";
import { tool as listTables } from "./list-tables";
import { tools as memory } from "./memory";
import { tool as manageMetricsWidget } from "./manage-metrics-widget";
import { tool as manageRule } from "./manage-rule";
import { tool as manageSchedule } from "./manage-schedule";
import { tool as manageSkill } from "./manage-skill";
import { tool as openTableTab } from "./open-table-tab";
import { tool as previewWrite } from "./preview-write";
import { tool as proposeSeedData } from "./propose-seed-data";
import { tool as readPage } from "./read-page";
import { tool as rememberTerm } from "./remember-term";
import { tool as runParameterizedSql } from "./run-parameterized-sql";
import { tool as runPreset } from "./run-preset";
import { tool as runReadonlySql } from "./run-readonly-sql";
import { tool as sampleTableData } from "./sample-table-data";
import { tool as searchSchema } from "./search-schema";
import { tools as skills } from "./skills";
import { tool as switchDatabase } from "./switch-database";
import { tool as updatePlan } from "./update-plan";
import type { AgentToolHandler, AgentToolModule } from "./shared";

const AGENT_TOOL_MODULES: AgentToolModule[] = [
  updatePlan,
  delegate,
  listTables,
  searchSchema,
  ...describeTable,
  sampleTableData,
  listSchemaObjects,
  runPreset,
  readPage,
  runReadonlySql,
  runParameterizedSql,
  findValue,
  checkSql,
  previewWrite,
  ...checkpoints,
  rememberTerm,
  ...skills,
  proposeSeedData,
  editQuerySql,
  ...memory,
  manageMetricsWidget,
  manageSchedule,
  openTableTab,
  manageSkill,
  manageRule,
  switchDatabase,
];

export const AGENT_TOOL_HANDLERS: Record<string, AgentToolHandler> = Object.fromEntries(
  AGENT_TOOL_MODULES.map((module) => [module.name, module.handler]),
);
