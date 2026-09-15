/**
 * Best-effort JSON recovery for model tool-call responses: strip code fences,
 * isolate the outermost JSON object, sanitize stray control characters inside
 * string literals, and repair truncated/unbalanced JSON. Pure string helpers
 * (no dependencies) consumed by parseAIAgentToolAction.
 */
export function stripOptionalCodeFence(text: string) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() || trimmed;
}

export function extractJsonObjectCandidate(text: string) {
  const stripped = stripOptionalCodeFence(text);
  const startIndex = stripped.indexOf("{");
  if (startIndex === -1) return stripped;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(startIndex, index + 1);
    }
  }

  return stripped.slice(startIndex);
}

export function sanitizeJsonStringLiterals(candidate: string) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (const char of candidate) {
    if (inString) {
      if (escaping) {
        result += char;
        escaping = false;
        continue;
      }
      if (char === "\\") {
        result += char;
        escaping = true;
        continue;
      }
      if (char === '"') {
        result += char;
        inString = false;
        continue;
      }
      if (char === "\n") {
        result += "\\n";
        continue;
      }
      if (char === "\r") {
        result += "\\r";
        continue;
      }
      if (char === "\t") {
        result += "\\t";
        continue;
      }

      const codePoint = char.charCodeAt(0);
      result += codePoint < 0x20 ? `\\u${codePoint.toString(16).padStart(4, "0")}` : char;
      continue;
    }

    if (char === '"') inString = true;
    result += char;
  }

  return result;
}

export function repairTruncatedJson(candidate: string) {
  let inString = false;
  let escaping = false;
  const stack: string[] = [];

  for (const char of candidate) {
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }

  let repaired = candidate;
  if (inString && escaping) repaired += "\\";
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    repaired += stack[index] === "{" ? "}" : "]";
  }

  return repaired;
}
