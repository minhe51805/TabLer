import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConversationMessage } from "@/types/ai";
import {
  createAgentActionRequestor,
  isSupersededAIRequestError,
  AI_REQUEST_REPLACED_MESSAGE,
} from "@/components/AISlidePanel/ai-agent-action-requestor";

const requestId = 7;

function makeRequestor(askAI: ReturnType<typeof vi.fn>) {
  return createAgentActionRequestor({
    askAI: askAI as never,
    context: "CTX",
    strictRecoveryContext: null,
    requestId,
    requestIdRef: { current: requestId },
    requestHistory: [{ role: "user", content: "hi" } as unknown as AIConversationMessage],
  });
}

describe("isSupersededAIRequestError / AI_REQUEST_REPLACED_MESSAGE", () => {
  it("detects superseded errors by message", () => {
    expect(isSupersededAIRequestError(new Error(AI_REQUEST_REPLACED_MESSAGE))).toBe(true);
    expect(isSupersededAIRequestError(AI_REQUEST_REPLACED_MESSAGE)).toBe(true);
    expect(isSupersededAIRequestError(new Error("other"))).toBe(false);
  });
});

describe("createAgentActionRequestor", () => {
  let askAI: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    askAI = vi.fn();
  });

  it("prefers strictRecoveryContext over plain context when set", async () => {
    askAI.mockResolvedValue('{"action":"finish"}');
    const strict = createAgentActionRequestor({
      askAI: askAI as never,
      context: "PLAIN",
      strictRecoveryContext: "STRICT",
      requestId,
      requestIdRef: { current: requestId },
      requestHistory: [],
    });
    await strict.requestAgentAction("P", false);
    expect(askAI.mock.calls[askAI.mock.calls.length - 1][1]).toBe("STRICT");
  });

  it("falls back to plain context when strict recovery is null", async () => {
    askAI.mockResolvedValue('{"action":"finish"}');
    const req = makeRequestor(askAI);
    await req.requestAgentAction("P", false);
    expect(askAI.mock.calls[0][1]).toBe("CTX");
  });

  it("appends repair notes to the controller prompt when provided", async () => {
    askAI.mockResolvedValueOnce('{"action":"finish"}');
    const req = makeRequestor(askAI);
    await req.requestAgentAction("P", false, "fix your output");
    expect(String(askAI.mock.calls[0][0])).toContain("Repair note:\nfix your output");
    expect(String(askAI.mock.calls[0][0])).toContain("P");
  });

  it("includes request history only when includeHistory is true", async () => {
    askAI.mockResolvedValue('{"action":"finish"}');
    const req = makeRequestor(askAI);
    await req.requestAgentAction("P1", true);
    await req.requestAgentAction("P2", false);
    expect((askAI.mock.calls[0][4] as unknown[]).length).toBe(1);
    expect((askAI.mock.calls[1][4] as unknown[]).length).toBe(0);
  });

  it("repairs invalid JSON by showing the model its own output", async () => {
    askAI
      .mockResolvedValueOnce("NOT VALID JSON {{")
      .mockResolvedValueOnce('{"action":"finish","message":"ok"}');

    const result = await makeRequestor(askAI).requestAgentAction("CTRL", false);

    expect(askAI).toHaveBeenCalledTimes(2);
    const repairPrompt = String(askAI.mock.calls[1][0]);
    expect(repairPrompt).toContain("was not valid");
    expect(repairPrompt).toContain("NOT VALID JSON {{");
    expect((result as { action: string }).action).toBe("finish");
  });

  it("throws the replaced-request error when a newer request took over", async () => {
    const req = createAgentActionRequestor({
      askAI: vi.fn().mockResolvedValue('{"action":"finish"}') as never,
      context: "CTX",
      strictRecoveryContext: null,
      requestId,
      requestIdRef: { current: requestId + 1 }, // bumped mid-flight
      requestHistory: [],
    });
    // parse succeeds, but the guard rejects because a newer request exists
    await expect(req.requestAgentAction("P", false)).rejects.toThrow(AI_REQUEST_REPLACED_MESSAGE);
  });
});
