import { describe, expect, it } from "vitest";
import {
  buildAttachmentFileBlocks,
  formatAttachmentBytes,
  isImageFileName,
  isTextFileName,
  toRequestAttachments,
  type AIAttachmentDraft,
} from "@/utils/ai-attachments";

function imageDraft(overrides: Partial<AIAttachmentDraft> = {}): AIAttachmentDraft {
  return {
    id: "img-1",
    kind: "image",
    name: "shot.png",
    mimeType: "image/png",
    size: 1234,
    createdAt: 1,
    dataUrl: "data:image/png;base64,AAAA",
    ...overrides,
  };
}

function textDraft(overrides: Partial<AIAttachmentDraft> = {}): AIAttachmentDraft {
  return {
    id: "txt-1",
    kind: "text",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 40,
    createdAt: 1,
    textContent: "hello world",
    ...overrides,
  };
}

describe("ai-attachments pure helpers", () => {
  it("detects image and text file names", () => {
    expect(isImageFileName("photo.PNG")).toBe(true);
    expect(isImageFileName("photo.svg")).toBe(false);
    expect(isTextFileName("query.sql")).toBe(true);
    expect(isTextFileName("report.xlsx")).toBe(false);
  });

  it("formats byte sizes", () => {
    expect(formatAttachmentBytes(512)).toBe("512 B");
    expect(formatAttachmentBytes(2048)).toBe("2 KB");
    expect(formatAttachmentBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("builds codex-style fenced blocks for text files only", () => {
    const block = buildAttachmentFileBlocks([imageDraft(), textDraft()]);
    expect(block).toContain("Attached file: notes.txt");
    expect(block).toContain("```\nhello world\n```");
    expect(block).not.toContain("shot.png");
    expect(buildAttachmentFileBlocks([imageDraft()])).toBe("");
    expect(buildAttachmentFileBlocks([])).toBe("");
  });

  it("maps only image drafts to request attachments, stripping the data-URL prefix", () => {
    const request = toRequestAttachments([imageDraft(), textDraft()]);
    expect(request).toHaveLength(1);
    expect(request[0]).toEqual({
      kind: "image",
      name: "shot.png",
      mime_type: "image/png",
      data: "AAAA",
    });
    expect(toRequestAttachments([textDraft()])).toHaveLength(0);
    expect(toRequestAttachments([])).toHaveLength(0);
  });
});
