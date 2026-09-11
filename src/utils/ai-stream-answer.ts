/**
 * Streaming helper for the AI agent path.
 *
 * Every agent model call streams a JSON *tool action* rather than plain prose,
 * e.g. `{"action":"finish","args":{"response":"…the answer…"}}`. Because the
 * raw text is JSON, the panel used to withhold it entirely while an agent turn
 * was loading and only render the parsed answer once the whole object arrived —
 * which made the reply appear to stall and then dump out all at once.
 *
 * `extractStreamingAgentAnswer` pulls the human-facing answer (`args.response`
 * of the finish action) out of the *partial* JSON as it streams in, decoding
 * JSON string escapes and tolerating a truncated tail (an unfinished escape or
 * `\uXXXX`). Tool-step actions have no `args.response`, so those return `null`
 * and nothing is streamed until the final answer starts landing.
 */

/** Matches the `"response":"` key/opening-quote inside a finish action. */
const RESPONSE_VALUE_START = /"response"\s*:\s*"/;

/**
 * Returns the partial decoded value of the finish action's `args.response`
 * string that has streamed in so far, or `null` when the response field has not
 * started yet (e.g. a tool-step action, or the object is still opening).
 */
export function extractStreamingAgentAnswer(rawStreamedJson: string): string | null {
  if (!rawStreamedJson) return null;
  const match = RESPONSE_VALUE_START.exec(rawStreamedJson);
  if (!match) return null;
  const valueStart = match.index + match[0].length;
  return decodePartialJsonString(rawStreamedJson, valueStart);
}

/**
 * Decodes a JSON string body starting at `start` (the first character after the
 * opening quote) up to the first unescaped closing quote, or to the end of the
 * currently-available text when the value is still streaming. A dangling escape
 * at the tail is dropped so the visible text never shows a stray backslash.
 */
function decodePartialJsonString(raw: string, start: number): string {
  let result = "";
  let index = start;

  while (index < raw.length) {
    const char = raw[index];

    if (char === "\\") {
      const next = raw[index + 1];
      // Escape introducer with nothing after it yet — wait for the next chunk.
      if (next === undefined) break;
      switch (next) {
        case "n": result += "\n"; break;
        case "t": result += "\t"; break;
        case "r": result += "\r"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "\"": result += "\""; break;
        case "\\": result += "\\"; break;
        case "/": result += "/"; break;
        case "u": {
          const hex = raw.slice(index + 2, index + 6);
          // Wait for the full \uXXXX before decoding a partial code point.
          if (hex.length < 4) return result;
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) {
            result += "\\u";
            index += 2;
            continue;
          }
          result += String.fromCharCode(code);
          index += 6;
          continue;
        }
        default:
          result += next;
          break;
      }
      index += 2;
      continue;
    }

    // Unescaped closing quote → the response value is complete.
    if (char === "\"") break;

    result += char;
    index += 1;
  }

  return result;
}
