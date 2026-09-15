/**
 * Agent tool schema barrel. The implementation is split into focused modules
 * under ./tool-schema (constants, specs, parsing, provider-formats); this file
 * re-exports them so the original import surface stays stable. Adding a tool
 * means adding one spec in ./tool-schema/specs (the Record<AIAgentToolName, ...>
 * type keeps the set exhaustive at compile time).
 */
export * from "./tool-schema/constants";
export * from "./tool-schema/specs";
export * from "./tool-schema/parsing";
export * from "./tool-schema/provider-formats";
