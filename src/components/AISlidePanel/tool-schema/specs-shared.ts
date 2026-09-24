import { type JsonSchema } from "./constants";

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
  additionalProperties = false,
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties,
  };
}

/**
 * Shared failure contract appended to tool descriptions so the model knows the
 * shape of a failed call: `Tool error: <message> {"error","hint","retryable"}`.
 * `hint` carries the corrective action (closest table names, SQL error
 * position); `retryable` tells whether re-issuing the same call can succeed.
 */
export const TOOL_ERROR_SHAPE_NOTE =
  ' On failure the observation is `Tool error: <message> {"error","hint","retryable"}` — follow `hint` and only retry when `retryable` is true.';
