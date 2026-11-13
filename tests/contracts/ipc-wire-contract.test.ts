import { describe, expect, it } from "vitest";
import agentMemoryRs from "../../src-tauri/src/agent_memory.rs?raw";
import agentRulesCommandsRs from "../../src-tauri/src/agent_rules/commands.rs?raw";
import aiStreamRs from "../../src-tauri/src/commands/ai/extraction/stream.rs?raw";
import aiModRs from "../../src-tauri/src/commands/ai/mod.rs?raw";
import queryModRs from "../../src-tauri/src/commands/query/mod.rs?raw";
import scheduleRs from "../../src-tauri/src/commands/schedule.rs?raw";
import configRs from "../../src-tauri/src/config.rs?raw";
import aiModelsRs from "../../src-tauri/src/database/ai_models.rs?raw";
import queryModelsRs from "../../src-tauri/src/database/models/query.rs?raw";
import errorRs from "../../src-tauri/src/error.rs?raw";
import aiLearningTsRaw from "../../src/components/AISlidePanel/ai-agent-learning.ts?raw";
import aiConversationStateTsRaw from "../../src/components/AISlidePanel/ai-conversation-state.ts?raw";
import postRunPipelineTsRaw from "../../src/components/AISlidePanel/agent-engine/post-run-pipeline.ts?raw";
import turnDriverTsRaw from "../../src/components/AISlidePanel/agent-engine/turn-driver.ts?raw";
import memoryToolTsRaw from "../../src/components/AISlidePanel/agent-tools/memory.ts?raw";
import useAiSqlRunnerTsRaw from "../../src/components/AISlidePanel/hooks/use-ai-sql-runner.ts?raw";
import agentScheduleStoreTsRaw from "../../src/stores/agent-schedule-store.ts?raw";
import aiStoreTsRaw from "../../src/stores/aiStore.ts?raw";
import querySchedulesStoreTsRaw from "../../src/stores/query-schedules-store.ts?raw";
import queryStoreTsRaw from "../../src/stores/queryStore.ts?raw";
import aiToolContractsTsRaw from "../../src/types/ai-tool-contracts.ts?raw";
import aiTypesTsRaw from "../../src/types/ai.ts?raw";
import databaseTypesTsRaw from "../../src/types/database.ts?raw";
import tauriErrorTsRaw from "../../src/utils/tauri-error.ts?raw";
import { createMultiTurnTranscript } from "@/components/AISlidePanel/agent-engine/multi-turn-transcript";
import { applyLearningProposal } from "@/components/AISlidePanel/ai-agent-learning";
import { SANDBOX_AGENT_MAX_ROWS } from "@/stores/queryStore";
import { TauriCommandError, toTauriCommandError } from "@/utils/tauri-error";

// ---------------------------------------------------------------------------
// Structural Rust / TypeScript extractors (brace-balanced, comment-safe)
// ---------------------------------------------------------------------------

function stripLineComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function stripComments(source: string): string {
  return stripLineComments(source).replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractInvokePayloadKeys(tsSource: string, commandName: string): string[] {
  const cleaned = stripComments(tsSource);
  const callRegex = new RegExp(
    `invoke(?:Mutation|WithTimeout|AIWorkspaceToolWithTimeout)?(?:<[^>]+>)?\\(\\s*"${commandName}"\\s*,\\s*\\{`,
  );
  const match = callRegex.exec(cleaned);
  if (!match || match.index === undefined) {
    throw new Error(`TS invoke call for "${commandName}" not found`);
  }
  const cmdLiteralIdx = cleaned.indexOf(`"${commandName}"`, match.index);
  const openBrace = cleaned.indexOf("{", cmdLiteralIdx);
  const closeBrace = findMatchingBrace(cleaned, openBrace);
  const body = cleaned.slice(openBrace + 1, closeBrace);
  const keys: string[] = [];
  for (const item of splitTopLevelItems(body)) {
    if (item.startsWith("...")) {
      const spreadObjects = item.matchAll(/\{([^{}]*)\}/g);
      for (const spreadObj of spreadObjects) {
        const inner = spreadObj[1].trim();
        if (!inner) continue;
        for (const innerItem of splitTopLevelItems(inner)) {
          const innerKey = innerItem.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/);
          if (innerKey) keys.push(innerKey[1]);
        }
      }
      continue;
    }
    const keyMatch = item.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/);
    if (!keyMatch) {
      throw new Error(`Could not parse JS invoke payload property in ${commandName}: ${item}`);
    }
    keys.push(keyMatch[1]);
  }
  return keys;
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("Unbalanced braces while parsing source block");
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function toSnakeCase(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function toKebabCase(pascal: string): string {
  return toSnakeCase(pascal).replace(/_/g, "-");
}

function applyRenameAll(rawName: string, renameAll: string | null): string {
  if (!renameAll) return rawName;
  switch (renameAll) {
    case "camelCase":
      return toCamelCase(rawName);
    case "kebab-case":
      return toKebabCase(rawName);
    case "snake_case":
      return toSnakeCase(rawName);
    case "lowercase":
      return rawName.toLowerCase();
    default:
      throw new Error(`Unsupported serde rename_all policy: ${renameAll}`);
  }
}

function parseSerdeAttributes(attrBlock: string): {
  renameAll: string | null;
  tag: string | null;
} {
  const renameAllMatch = attrBlock.match(/rename_all\s*=\s*"([^"]+)"/);
  const tagMatch = attrBlock.match(/tag\s*=\s*"([^"]+)"/);
  return {
    renameAll: renameAllMatch ? renameAllMatch[1] : null,
    tag: tagMatch ? tagMatch[1] : null,
  };
}

function extractLeadingRustAttributes(source: string, declIndex: number): string {
  const prefix = source.slice(0, declIndex);
  const lines = prefix.split(/\r?\n/);
  const collected: string[] = [];
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("///") || trimmed.startsWith("#[")) {
      collected.unshift(trimmed);
      continue;
    }
    break;
  }
  return collected.join("\n");
}

function extractRustDeclarationBlock(
  source: string,
  kind: "struct" | "enum",
  name: string,
): { attrs: string; body: string } {
  const cleaned = stripLineComments(source);
  const regex = new RegExp(`(?:pub(?:\\([^)]*\\))?\\s+)?${kind}\\s+${name}\\b[^;{]*\\{`);
  const match = regex.exec(cleaned);
  if (!match || match.index === undefined) {
    throw new Error(`Rust ${kind} ${name} not found`);
  }
  const openBrace = cleaned.indexOf("{", match.index);
  const closeBrace = findMatchingBrace(cleaned, openBrace);
  const attrs = extractLeadingRustAttributes(cleaned, match.index);
  return {
    attrs,
    body: cleaned.slice(openBrace + 1, closeBrace),
  };
}

function splitTopLevelItems(body: string): string[] {
  const items: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  let start = 0;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      braceDepth += 1;
    } else if (ch === "}") {
      braceDepth -= 1;
    } else if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      parenDepth -= 1;
    } else if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth -= 1;
    } else if (ch === "<") {
      angleDepth += 1;
    } else if (ch === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (
      ch === "," &&
      braceDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      const piece = body.slice(start, i).trim();
      if (piece) items.push(piece);
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) items.push(tail);
  return items;
}

function parseRustFieldList(
  body: string,
  renameAll: string | null,
): Array<{ rustName: string; wireName: string; rustType: string }> {
  return splitTopLevelItems(body).map((rawItem) => {
    const renameMatch = rawItem.match(/#\[serde\([^)]*rename\s*=\s*"([^"]+)"/);
    const withoutAttrs = rawItem.replace(/#\[[^\]]*\]\s*/g, "").trim();
    const match = withoutAttrs.match(
      /^(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/,
    );
    if (!match) {
      throw new Error(`Could not parse Rust field: ${rawItem}`);
    }
    const rustName = match[1];
    const wireName = renameMatch ? renameMatch[1] : applyRenameAll(rustName, renameAll);
    return {
      rustName,
      wireName,
      rustType: match[2].trim(),
    };
  });
}

function parseRustStructWireKeys(source: string, structName: string): string[] {
  const { attrs, body } = extractRustDeclarationBlock(source, "struct", structName);
  const { renameAll } = parseSerdeAttributes(attrs);
  return parseRustFieldList(body, renameAll).map((field) => field.wireName);
}

function parseRustEnumWireVariants(
  source: string,
  enumName: string,
): {
  tag: string | null;
  variants: Array<{ rustName: string; wireTag: string; fields: string[] }>;
} {
  const { attrs, body } = extractRustDeclarationBlock(source, "enum", enumName);
  const { renameAll, tag } = parseSerdeAttributes(attrs);
  const variants = splitTopLevelItems(body).map((rawItem) => {
    const renameMatch = rawItem.match(/#\[serde\([^)]*rename\s*=\s*"([^"]+)"/);
    const withoutAttrs = rawItem.replace(/#\[[^\]]*\]\s*/g, "").trim();
    const braceIdx = withoutAttrs.indexOf("{");
    if (braceIdx === -1) {
      const rustName = withoutAttrs.replace(/\(.*\)$/, "").trim();
      const wireTag = renameMatch ? renameMatch[1] : applyRenameAll(rustName, renameAll);
      return { rustName, wireTag, fields: [] };
    }
    const rustName = withoutAttrs.slice(0, braceIdx).trim();
    const closeBrace = findMatchingBrace(withoutAttrs, braceIdx);
    const variantBody = withoutAttrs.slice(braceIdx + 1, closeBrace);
    // Serde applies enum-level `rename_all` to the variant name; struct-variant
    // fields remain snake_case unless individually annotated with #[serde(rename)].
    const wireTag = renameMatch ? renameMatch[1] : applyRenameAll(rustName, renameAll);
    const fields = parseRustFieldList(variantBody, null).map((field) => field.wireName);
    return { rustName, wireTag, fields };
  });
  return { tag, variants };
}

function extractTsInterfaceKeys(source: string, interfaceName: string): string[] {
  const cleaned = stripLineComments(source);
  const regex = new RegExp(`(?:export\\s+)?interface\\s+${interfaceName}\\b[^\\{]*\\{`);
  const match = regex.exec(cleaned);
  if (!match || match.index === undefined) {
    throw new Error(`TypeScript interface ${interfaceName} not found`);
  }
  const openBrace = cleaned.indexOf("{", match.index);
  const closeBrace = findMatchingBrace(cleaned, openBrace);
  const body = cleaned.slice(openBrace + 1, closeBrace).replace(/\/\*[\s\S]*?\*\//g, "");

  const keys: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      braceDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0 &&
      trimmed.length > 0
    ) {
      const propMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/);
      if (propMatch) {
        keys.push(propMatch[1]);
      }
    }
    for (const ch of trimmed) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth -= 1;
      else if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth -= 1;
      else if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth -= 1;
      else if (ch === "<") angleDepth += 1;
      else if (ch === ">" && angleDepth > 0) angleDepth -= 1;
    }
  }
  return keys;
}

function extractTsUnionLiterals(source: string, typeName: string): string[] {
  const cleaned = stripLineComments(source).replace(/\/\*[\s\S]*?\*\//g, "");
  const regex = new RegExp(`(?:export\\s+)?type\\s+${typeName}\\s*=([\\s\\S]*?);`);
  const match = regex.exec(cleaned);
  if (!match) {
    throw new Error(`TypeScript union type ${typeName} not found`);
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function extractRustCommandParams(
  source: string,
  fnName: string,
): Array<{ rustName: string; jsArgName: string; rustType: string }> {
  const cleaned = stripLineComments(source);
  const regex = new RegExp(`pub\\s+(?:async\\s+)?fn\\s+${fnName}\\s*\\(`);
  const match = regex.exec(cleaned);
  if (!match || match.index === undefined) {
    throw new Error(`Rust command ${fnName} not found`);
  }
  const openParen = cleaned.indexOf("(", match.index);
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < cleaned.length; i += 1) {
    if (cleaned[i] === "(") depth += 1;
    else if (cleaned[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen === -1) {
    throw new Error(`Unbalanced params in Rust command ${fnName}`);
  }
  const paramsBody = cleaned.slice(openParen + 1, closeParen);
  return parseRustFieldList(paramsBody, null)
    .filter(
      ({ rustType }) =>
        !rustType.startsWith("State<") &&
        !rustType.startsWith("AppHandle") &&
        !rustType.startsWith("tauri::"),
    )
    .map(({ rustName, rustType }) => ({
      rustName,
      jsArgName: toCamelCase(rustName),
      rustType,
    }));
}

function extractRustCommandReturnType(source: string, fnName: string): string {
  const cleaned = stripLineComments(source);
  const regex = new RegExp(`pub\\s+(?:async\\s+)?fn\\s+${fnName}\\s*\\(`);
  const match = regex.exec(cleaned);
  if (!match || match.index === undefined) {
    throw new Error(`Rust command ${fnName} not found`);
  }
  const openParen = cleaned.indexOf("(", match.index);
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < cleaned.length; i += 1) {
    if (cleaned[i] === "(") depth += 1;
    else if (cleaned[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  const afterParen = cleaned.slice(closeParen + 1);
  const braceIdx = afterParen.indexOf("{");
  const sigTail = afterParen.slice(0, braceIdx);
  const arrowMatch = sigTail.match(/->\s*([\s\S]+)/);
  if (!arrowMatch) {
    throw new Error(`Return type not found for ${fnName}`);
  }
  return arrowMatch[1].trim();
}

// ---------------------------------------------------------------------------
// 1. ErrorCode & AppErrorWire parity
// ---------------------------------------------------------------------------

describe("IPC wire contract: ErrorCode and AppErrorWire (src-tauri/src/error.rs <-> src/utils/tauri-error.ts)", () => {
  it("ErrorCode variants (#[serde(rename_all = kebab-case)]) match TauriErrorCode 1-to-1", () => {
    const rustEnum = parseRustEnumWireVariants(errorRs, "ErrorCode");
    const rustWireCodes = rustEnum.variants.map((v) => v.wireTag);
    const tsCodes = extractTsUnionLiterals(tauriErrorTsRaw, "TauriErrorCode");

    // Cross-check ErrorCode::as_str arm literals as a second witness in error.rs.
    const asStrArms = Array.from(
      errorRs.matchAll(/ErrorCode::[A-Za-z0-9_]+\s*=>\s*"([^"]+)"/g),
      (m) => m[1],
    );
    expect(new Set(asStrArms)).toEqual(new Set(rustWireCodes));
    expect(tsCodes.length).toBe(rustWireCodes.length);
    expect(new Set(tsCodes)).toEqual(new Set(rustWireCodes));
  });

  it("AppErrorWire (#[serde(rename_all = camelCase)]) matches TauriErrorPayload and toTauriCommandError", () => {
    const rustWireFields = parseRustStructWireKeys(errorRs, "AppErrorWire");
    const tsPayloadFields = extractTsInterfaceKeys(tauriErrorTsRaw, "TauriErrorPayload");

    expect(new Set(tsPayloadFields)).toEqual(new Set(rustWireFields));
    expect(rustWireFields).toContain("retryAfterMs");

    const rawRustRejection = {
      code: "ai-rate-limited",
      message: "Provider quota exceeded",
      retryable: true,
      retryAfterMs: 2500,
      stage: "provider",
      hint: "Retry after backoff",
    };
    const normalized = toTauriCommandError(rawRustRejection);
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized).toMatchObject({
      name: "TauriCommandError",
      code: "ai-rate-limited",
      message: "Provider quota exceeded",
      retryable: true,
      retryAfterMs: 2500,
      stage: "provider",
      hint: "Retry after backoff",
    });
  });

  it("toTauriCommandError normalizes retryAfterMs edge cases, legacy stage, fallback messages, and primitives", () => {
    // 1) retryAfterMs: 0 stays 0; missing retryable defaults to false
    const zeroRetry = toTauriCommandError({
      code: "rate-limited",
      message: "Slow down",
      retryAfterMs: 0,
    }) as TauriCommandError;
    expect(zeroRetry).toBeInstanceOf(TauriCommandError);
    expect(zeroRetry.retryAfterMs).toBe(0);
    expect(zeroRetry.retryable).toBe(false);

    // 2) Non-finite / non-number retryAfterMs values normalize to undefined
    for (const badRetry of [Number.NaN, Number.POSITIVE_INFINITY, "2500"]) {
      const normalized = toTauriCommandError({
        code: "ai-rate-limited",
        message: "Limit hit",
        retryable: true,
        retryAfterMs: badRetry,
      }) as TauriCommandError;
      expect(normalized.retryAfterMs).toBeUndefined();
      expect(normalized.retryable).toBe(true);
    }

    // 3) Legacy ConnectionErrorInfo ({ stage, message } without code) defaults code to "connection-error"
    const legacyStage = toTauriCommandError({
      stage: "auth",
      message: "Invalid password",
    }) as TauriCommandError;
    expect(legacyStage).toMatchObject({
      name: "TauriCommandError",
      code: "connection-error",
      message: "Invalid password",
      stage: "auth",
      retryable: false,
    });

    // 4) { error } without message falls back to error string and "internal"
    const errorFieldOnly = toTauriCommandError({
      error: "Driver failure",
    }) as TauriCommandError;
    expect(errorFieldOnly).toMatchObject({
      name: "TauriCommandError",
      code: "internal",
      message: "Driver failure",
      retryable: false,
    });

    // 5) Unknown object without message/error serializes via JSON.stringify
    const rawUnknown = { detail: "boom", status: 500 };
    const unknownObj = toTauriCommandError(rawUnknown) as TauriCommandError;
    expect(unknownObj).toMatchObject({
      name: "TauriCommandError",
      code: "internal",
      message: JSON.stringify(rawUnknown),
      retryable: false,
    });

    // 6) null & primitive string rejections normalize with code "internal" and retryable false
    const nullRejection = toTauriCommandError(null) as TauriCommandError;
    expect(nullRejection).toMatchObject({
      name: "TauriCommandError",
      code: "internal",
      message: "null",
      retryable: false,
    });
    const strRejection = toTauriCommandError("socket closed") as TauriCommandError;
    expect(strRejection).toMatchObject({
      name: "TauriCommandError",
      code: "internal",
      message: "socket closed",
      retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. AI wire structs & enums (ai_models.rs / commands/ai/mod.rs <-> TS)
// ---------------------------------------------------------------------------

describe("IPC wire contract: AI models and streaming events", () => {
  it("AI enum wire values match src/types/ai.ts union literals 1-to-1", () => {
    const pairs: Array<[string, string]> = [
      ["AIProviderType", "AIProviderType"],
      ["AIRequestMode", "AIRequestMode"],
      ["AIRequestIntent", "AIRequestIntent"],
      ["AIResponseLanguage", "AIResponseLanguage"],
      ["AIConversationRole", "AIConversationRole"],
    ];
    for (const [rustName, tsName] of pairs) {
      const rustValues = parseRustEnumWireVariants(aiModelsRs, rustName).variants.map(
        (v) => v.wireTag,
      );
      const tsValues = extractTsUnionLiterals(aiTypesTsRaw, tsName);
      expect(new Set(tsValues), `${rustName} <-> ${tsName}`).toEqual(new Set(rustValues));
    }
  });

  it("AIRequest, AIResponse, CanonicalToolSpec, CanonicalToolCall, AIUsageStats, AIRequestAttachment keep snake_case parity", () => {
    const structPairs: Array<[string, string]> = [
      ["AIRequest", "AIRequest"],
      ["AIResponse", "AIResponse"],
      ["CanonicalToolSpec", "CanonicalToolSpec"],
      ["CanonicalToolCall", "CanonicalToolCall"],
      ["AIUsageStats", "AIUsageStats"],
      ["AIRequestAttachment", "AIRequestAttachment"],
      ["AIConversationMessage", "AIConversationMessage"],
    ];
    for (const [rustStruct, tsInterface] of structPairs) {
      const rustFields = parseRustStructWireKeys(aiModelsRs, rustStruct);
      const tsFields = extractTsInterfaceKeys(aiTypesTsRaw, tsInterface);
      expect(new Set(tsFields), `${rustStruct} <-> ${tsInterface}`).toEqual(new Set(rustFields));
    }
  });

  it("aiStore.ts requestPayload sends only valid snake_case AIRequest wire keys (no #[serde(default)]-masked camelCase keys)", () => {
    const rustRequestKeys = new Set(parseRustStructWireKeys(aiModelsRs, "AIRequest"));
    const payloadMatch = aiStoreTsRaw.match(/const requestPayload\s*=\s*\{([\s\S]*?)\n\s*\};/);
    expect(payloadMatch).not.toBeNull();
    const payloadBody = payloadMatch![1];

    // Extract object property keys directly inside requestPayload (top-level or spread ternary blocks).
    const sentKeys = Array.from(
      payloadBody.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|,)/gm),
      (m) => m[1],
    );
    expect(sentKeys.length).toBeGreaterThanOrEqual(8);
    for (const key of sentKeys) {
      expect(
        rustRequestKeys.has(key),
        `aiStore requestPayload sends unknown AIRequest key "${key}" (would be silently ignored by Rust #[serde(default)])`,
      ).toBe(true);
    }

    // Also verify response consumption reads snake_case fields from AIResponse.
    expect(aiStoreTsRaw).toContain("tool_calls");
    expect(aiStoreTsRaw).toContain("thought_signature");
  });

  it("CanonicalAgentTurn (#[serde(tag = role, rename_all = snake_case)]) matches TS union and runtime transcript output", () => {
    const rustTurn = parseRustEnumWireVariants(aiModelsRs, "CanonicalAgentTurn");
    expect(rustTurn.tag).toBe("role");
    expect(rustTurn.variants.map((v) => v.wireTag)).toEqual(["user", "assistant", "tool_result"]);

    const assistantVariant = rustTurn.variants.find((v) => v.wireTag === "assistant")!;
    const toolResultVariant = rustTurn.variants.find((v) => v.wireTag === "tool_result")!;
    const userVariant = rustTurn.variants.find((v) => v.wireTag === "user")!;

    expect(new Set(userVariant.fields)).toEqual(new Set(["content"]));
    expect(new Set(assistantVariant.fields)).toEqual(
      new Set(["text", "reasoning", "thought_signature", "tool_calls"]),
    );
    expect(new Set(toolResultVariant.fields)).toEqual(
      new Set(["call_id", "tool_name", "content", "is_error"]),
    );

    // Runtime check against the real multi-turn transcript builder.
    const transcript = createMultiTurnTranscript();
    transcript.recordAssistantToolTurn({
      text: "Inspecting schema",
      reasoning: "Checking columns first",
      thoughtSignature: "sig-xyz",
      toolCalls: [{ id: "call_1", name: "describe_table", arguments: { table: "users" } }],
      stepOrdinalHint: 1,
    });
    transcript.recordToolResult({
      callId: "call_1",
      toolName: "describe_table",
      observation: "Tool error: column not found",
      stepOrdinal: 1,
    });
    transcript.recordUserGuidance("Try table accounts instead", 2);

    const serialized = JSON.parse(JSON.stringify(transcript.getTurns())) as Array<
      Record<string, unknown>
    >;
    expect(serialized).toHaveLength(3);
    expect(serialized[0].role).toBe("assistant");
    expect(
      Object.keys(serialized[0])
        .filter((k) => k !== "role")
        .every((k) => assistantVariant.fields.includes(k)),
    ).toBe(true);
    expect(serialized[0]).toHaveProperty("thought_signature", "sig-xyz");
    expect(serialized[0]).toHaveProperty("tool_calls");

    expect(serialized[1].role).toBe("tool_result");
    expect(
      Object.keys(serialized[1])
        .filter((k) => k !== "role")
        .every((k) => toolResultVariant.fields.includes(k)),
    ).toBe(true);
    expect(serialized[1]).toMatchObject({
      call_id: "call_1",
      tool_name: "describe_table",
      is_error: true,
    });

    expect(serialized[2]).toEqual({ role: "user", content: "Try table accounts instead" });
  });

  it("AIStreamEvent (#[serde(rename_all = camelCase)]) and emitted kinds match aiStore.ts listener", () => {
    const rustStreamFields = parseRustStructWireKeys(aiModRs, "AIStreamEvent");
    expect(new Set(rustStreamFields)).toEqual(new Set(["requestId", "kind", "text", "usage"]));

    const emittedKinds = new Set([
      ...Array.from(aiModRs.matchAll(/emit_ai_stream_event\([^;]+?,\s*"([^"]+)"/g), (m) => m[1]),
      ...Array.from(
        aiStreamRs.matchAll(/(?:emit_ai_stream_event\([^;]+?,\s*|\bemit\(\s*)"([^"]+)"/g),
        (m) => m[1],
      ),
    ]);
    expect(emittedKinds).toEqual(
      new Set(["text_delta", "reasoning_delta", "usage", "done", "error"]),
    );

    // Verify aiStore listens to "ai-stream-event" with matching camelCase properties and handled kinds.
    const listenMatch = aiStoreTsRaw.match(/listen<\{([\s\S]*?)\}>\("ai-stream-event"/);
    expect(listenMatch).not.toBeNull();
    const listenerType = listenMatch![1];
    for (const key of rustStreamFields) {
      expect(listenerType).toContain(key);
    }
    for (const kind of emittedKinds) {
      expect(listenerType).toContain(`"${kind}"`);
    }
  });

  it("AiLimits (#[serde(rename_all = camelCase)]) matches AiLimitsPayload in ai-conversation-state.ts", () => {
    const rustLimitsFields = parseRustStructWireKeys(aiModRs, "AiLimits");
    const tsLimitsFields = extractTsInterfaceKeys(aiConversationStateTsRaw, "AiLimitsPayload");
    expect(new Set(rustLimitsFields)).toEqual(new Set(["maxHistoryMessages", "maxHistoryChars"]));
    expect(new Set(tsLimitsFields)).toEqual(new Set(rustLimitsFields));
  });
});

// ---------------------------------------------------------------------------
// 3. QueryResult & MemoryEntry IPC parity
// ---------------------------------------------------------------------------

describe("IPC wire contract: QueryResult and Agent Memory structs", () => {
  it("QueryResult and ColumnInfo snake_case fields match src/types/database.ts", () => {
    const rustQueryResultKeys = parseRustStructWireKeys(queryModelsRs, "QueryResult");
    const tsQueryResultKeys = extractTsInterfaceKeys(databaseTypesTsRaw, "QueryResult").filter(
      (k) => k !== "cached",
    );
    expect(new Set(tsQueryResultKeys)).toEqual(new Set(rustQueryResultKeys));

    const rustColumnKeys = parseRustStructWireKeys(queryModelsRs, "ColumnInfo");
    const tsColumnKeys = extractTsInterfaceKeys(databaseTypesTsRaw, "ColumnInfo");
    expect(new Set(tsColumnKeys)).toEqual(new Set(rustColumnKeys));
  });

  it("MemoryEntrySummary and MemoryEntryContent camelCase wire keys match agent-tools/memory.ts", () => {
    const summaryKeys = parseRustStructWireKeys(agentMemoryRs, "MemoryEntrySummary");
    const contentKeys = parseRustStructWireKeys(agentMemoryRs, "MemoryEntryContent");
    expect(new Set(summaryKeys)).toEqual(new Set(["name", "description", "updatedAt", "origin"]));
    expect(new Set(contentKeys)).toEqual(new Set(["name", "description", "updatedAt", "body"]));

    expect(memoryToolTsRaw).toContain("updatedAt");
    expect(memoryToolTsRaw).toContain("body");
  });
});

// ---------------------------------------------------------------------------
// 4. Command parameter parity (Rust #[tauri::command] <-> TS invoke payloads)
// ---------------------------------------------------------------------------

describe("IPC command parameter parity (Rust #[tauri::command] snake_case <-> TS camelCase)", () => {
  const cases: Array<{
    command: string;
    rustSource: string;
    tsSource: string;
    label: string;
  }> = [
    {
      command: "execute_agent_readonly_query",
      rustSource: queryModRs,
      tsSource: queryStoreTsRaw,
      label: "queryStore.ts -> execute_agent_readonly_query",
    },
    {
      command: "execute_agent_parameterized_query",
      rustSource: queryModRs,
      tsSource: queryStoreTsRaw,
      label: "queryStore.ts -> execute_agent_parameterized_query",
    },
    {
      command: "preview_write_transaction",
      rustSource: queryModRs,
      tsSource: queryStoreTsRaw,
      label: "queryStore.ts -> preview_write_transaction",
    },
    {
      command: "explain_agent_statement",
      rustSource: queryModRs,
      tsSource: turnDriverTsRaw,
      label: "turn-driver.ts -> explain_agent_statement",
    },
    {
      command: "save_agent_memory",
      rustSource: agentMemoryRs,
      tsSource: aiLearningTsRaw,
      label: "ai-agent-learning.ts -> save_agent_memory",
    },
    {
      command: "save_agent_memory",
      rustSource: agentMemoryRs,
      tsSource: memoryToolTsRaw,
      label: "agent-tools/memory.ts -> save_agent_memory",
    },
    {
      command: "save_agent_rule",
      rustSource: agentRulesCommandsRs,
      tsSource: aiLearningTsRaw,
      label: "ai-agent-learning.ts -> save_agent_rule",
    },
    {
      command: "save_query_schedule",
      rustSource: scheduleRs,
      tsSource: querySchedulesStoreTsRaw,
      label: "query-schedules-store.ts -> save_query_schedule",
    },
    {
      command: "complete_agent_schedule_run",
      rustSource: scheduleRs,
      tsSource: agentScheduleStoreTsRaw,
      label: "agent-schedule-store.ts -> complete_agent_schedule_run",
    },
  ];

  for (const { command, rustSource, tsSource, label } of cases) {
    it(`${label} sends exact Rust camelCase argument names`, () => {
      const rustParams = extractRustCommandParams(rustSource, command);
      const validRustArgNames = new Set(rustParams.map((p) => p.jsArgName));
      const requiredRustArgNames = rustParams
        .filter((p) => !p.rustType.startsWith("Option<"))
        .map((p) => p.jsArgName);
      const sentKeys = extractInvokePayloadKeys(tsSource, command);

      for (const sentKey of sentKeys) {
        expect(validRustArgNames.has(sentKey), `${label} sends unknown argument "${sentKey}"`).toBe(
          true,
        );
      }
      for (const requiredKey of requiredRustArgNames) {
        expect(sentKeys, `${label} omits required Rust argument "${requiredKey}"`).toContain(
          requiredKey,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Confirmed Phase A IPC / Sandbox-Scope Bugs (expected RED until Phase B)
// ---------------------------------------------------------------------------

describe("IPC wire contract regressions (confirmed Phase A bugs)", () => {
  it("BUG-1: agent SQL validation in post-run-pipeline.ts must pass maxRows so execute_sandboxed_query enters SandboxCallerScope::Agent with a row cap", () => {
    const rustMaxRowsMatch = configRs.match(
      /pub const SANDBOX_AGENT_MAX_ROWS\s*:\s*usize\s*=\s*([0-9_]+)/,
    );
    expect(rustMaxRowsMatch).not.toBeNull();
    expect(SANDBOX_AGENT_MAX_ROWS).toBe(
      Number.parseInt(rustMaxRowsMatch![1].replace(/_/g, ""), 10),
    );

    // Backend rule in src-tauri/src/commands/query/mod.rs:
    // SandboxCallerScope::Agent is selected ONLY when `max_rows.is_some()`.
    expect(stripComments(queryModRs)).toMatch(
      /if\s+max_rows\.is_some\(\)\s*\{\s*SandboxCallerScope::Agent\s*\}\s*else\s*\{\s*SandboxCallerScope::Workspace\s*\}/,
    );
    const rustCommandArgs = new Set(
      extractRustCommandParams(queryModRs, "execute_sandboxed_query").map((p) => p.jsArgName),
    );
    expect(rustCommandArgs).toContain("maxRows");

    // 1) Contract type must declare maxRows
    const tsContractArgs = extractTsInterfaceKeys(
      aiToolContractsTsRaw,
      "AIExecuteSandboxedQueryCommandArgs",
    );
    expect(tsContractArgs, "AIExecuteSandboxedQueryCommandArgs omits maxRows").toContain("maxRows");

    // 2) queryStore.executeSandboxQuery must forward maxRows over IPC (comments stripped)
    const sentKeys = extractInvokePayloadKeys(queryStoreTsRaw, "execute_sandboxed_query");
    expect(
      sentKeys,
      "queryStore.executeSandboxQuery never forwards maxRows to execute_sandboxed_query",
    ).toContain("maxRows");

    // 3) Agent validation caller in post-run-pipeline.ts (validateSql) must pass maxRows (comments stripped)
    const validateSqlMatch = stripComments(postRunPipelineTsRaw).match(
      /validateSql:\s*async\s*\(proposedSql\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\n\s*\}\);/,
    );
    expect(validateSqlMatch).not.toBeNull();
    expect(
      validateSqlMatch![1],
      "post-run-pipeline validateSql calls executeSandboxQuery without maxRows, leaking into SandboxCallerScope::Workspace with unbounded rows",
    ).toMatch(/\bmaxRows\b/);
  });

  it("BUG-1b: use-ai-sql-runner.ts (agent auto-run path) must pass maxRows when running agent-generated SQL", () => {
    const cleanedRunner = stripComments(useAiSqlRunnerTsRaw);
    const callMatch = cleanedRunner.match(/executeSandboxQuery\s*\(([\s\S]*?)\)\s*;/);
    expect(callMatch).not.toBeNull();
    expect(
      callMatch![1],
      "use-ai-sql-runner.ts calls executeSandboxQuery without maxRows, so agent auto-run SQL leaks into SandboxCallerScope::Workspace unbounded",
    ).toMatch(/\bmaxRows\b/);
  });

  it("BUG-2: post-run-pipeline.ts must serialize requestId as string when invoking save_agent_trace(request_id: String)", () => {
    const saveTraceParams = extractRustCommandParams(aiModRs, "save_agent_trace");
    const requestIdParam = saveTraceParams.find((p) => p.jsArgName === "requestId");
    expect(requestIdParam).toBeDefined();
    expect(requestIdParam!.rustType).toBe("String");

    // finalizeAgentRun types `requestId: number`, yet invokes `save_agent_trace` with `{ requestId, ... }`.
    expect(postRunPipelineTsRaw).toMatch(/requestId:\s*number;/);
    const traceInvokeMatch = postRunPipelineTsRaw.match(
      /invokeMutation<string>\(\s*"save_agent_trace",\s*\{([\s\S]*?)\}/,
    );
    expect(traceInvokeMatch).not.toBeNull();
    expect(
      traceInvokeMatch![1],
      "save_agent_trace passes raw numeric `requestId` to Rust `request_id: String`",
    ).toMatch(/requestId:\s*(?:String\(|`\$\{requestId\}`|requestId\.toString\()/);
  });

  it("BUG-3: applyLearningProposal('memory') must extract MemoryEntrySummary.name instead of coercing object to '[object Object]'", async () => {
    const returnType = extractRustCommandReturnType(agentMemoryRs, "save_agent_memory");
    expect(returnType).toContain("MemoryEntrySummary");

    // Verify applyLearningProposal source also expects MemoryEntrySummary rather than raw String(...)
    expect(aiLearningTsRaw).toContain("save_agent_memory");

    // Invoke real applyLearningProposal with the exact JSON shape Rust `save_agent_memory` serializes.
    const rustWireResponse = {
      name: "dead-column-users-legacy_flag",
      description: "Avoid filtering on dropped legacy_flag column",
      updatedAt: "2026-11-13T12:00:00Z",
      origin: "agent",
    };

    const resultText = await applyLearningProposal(
      {
        id: "learn-1",
        kind: "memory",
        title: "Remember dead column",
        rationale: "users.legacy_flag was removed",
        memory: {
          name: rustWireResponse.name,
          description: rustWireResponse.description,
          body: "Do not query users.legacy_flag.",
        },
      },
      { connectionId: "conn-1", database: "app" },
      async (command) => {
        expect(command).toBe("save_agent_memory");
        return rustWireResponse;
      },
    );

    expect(resultText).not.toBe("[object Object]");
    expect(resultText).toContain(rustWireResponse.name);
  });
});
