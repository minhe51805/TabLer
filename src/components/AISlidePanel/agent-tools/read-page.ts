import { stringifyAgentObservationFull } from "../ai-agent-grounding";
import { AI_AGENT_READ_PAGE_MAX_CHARS } from "../ai-agent-tools";
import { agentToolError } from "../agent-tool-executor-helpers";
import type { AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "read_page",
  handler: async (ctx, args) => {
    const total = ctx.observationArchive.length;
    if (total === 0) {
      return agentToolError(
        "read_page has nothing to page through - no tool observations exist in this run yet.",
        { hint: "Run a real tool first; read_page only re-reads earlier observations." },
      );
    }
    const requestedRef =
      typeof args?.ref === "number" && Number.isFinite(args.ref) ? Math.floor(args.ref) : total;
    if (requestedRef < 1 || requestedRef > total) {
      return agentToolError(
        `read_page args.ref must be between 1 and ${total} (this run produced ${total} observation(s)).`,
        { hint: `Pick args.ref in [1, ${total}] or omit it for the latest observation.` },
      );
    }
    const entry = ctx.observationArchive[requestedRef - 1];
    const offset =
      typeof args?.offset === "number" && Number.isFinite(args.offset)
        ? Math.max(0, Math.floor(args.offset))
        : 0;
    const limit =
      typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(AI_AGENT_READ_PAGE_MAX_CHARS, Math.max(100, Math.floor(args.limit)))
        : 1400;
    if (offset >= entry.full.length) {
      return stringifyAgentObservationFull({
        ref: requestedRef,
        action: entry.action,
        totalChars: entry.full.length,
        offset,
        note: "Offset is past the end of this observation. Use a smaller offset.",
      });
    }
    const slice = entry.full.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return stringifyAgentObservationFull({
      ref: requestedRef,
      action: entry.action,
      totalChars: entry.full.length,
      offset,
      nextOffset: nextOffset < entry.full.length ? nextOffset : undefined,
      hasMore: nextOffset < entry.full.length || undefined,
      text: slice,
    });
  },
};
