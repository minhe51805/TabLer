import { type AIAgentToolName, type AIAgentToolSpec } from "./constants";
import { SPECS as AGENT_SPECS } from "./specs-agent";
import { SPECS as MEMORY_SPECS } from "./specs-memory";
import { SPECS as SCHEMA_SPECS } from "./specs-schema";
import { SPECS as WRITE_SPECS } from "./specs-write";

/**
 * Declarative tool specs keyed by action name. The Record<AIAgentToolName, ...>
 * type makes the set exhaustive: adding a tool to AI_AGENT_TOOL_NAMES forces a
 * spec here at compile time, keeping the native-calling contract in lockstep
 * with the parser registry. Specs live in per-domain modules (specs-schema,
 * specs-write, specs-agent, specs-memory) and merge here.
 */
export const AI_AGENT_TOOL_SPECS: Record<AIAgentToolName, AIAgentToolSpec> = {
  ...SCHEMA_SPECS,
  ...WRITE_SPECS,
  ...AGENT_SPECS,
  ...MEMORY_SPECS,
} as Record<AIAgentToolName, AIAgentToolSpec>;
