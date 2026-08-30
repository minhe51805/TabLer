/**
 * AI chat attachment pipeline (Claude/Codex-style):
 * - Images are downscaled/re-encoded on a canvas (max ~1568px, like Anthropic)
 *   so the persisted base64 payload stays small before it hits SQLite.
 * - Text files (sql/csv/json/md/txt/log/...) are read inline and appended to
 *   the prompt as fenced blocks, the way Codex attaches files.
 * - Bytes live in the backend `ai_attachments` table; bubbles only carry
 *   metadata, and image payloads are fetched on demand for rendering.
 */
import { invokeMutation } from "./tauri-utils";
import type { AIRequestAttachment } from "../types/ai";
import type { AIWorkspaceAttachment } from "../components/AISlidePanel/ai-workspace-types";

export const MAX_IMAGE_DIMENSION = 1568;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_FILE_CHARS = 200_000;
const MAX_FILES_PER_TURN = 8;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
  "sql", "log", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "rb",
  "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "env",
  "ini", "cfg", "conf", "diff", "patch",
]);

export interface AIAttachmentDraft extends AIWorkspaceAttachment {
  /** data:image/...;base64,... — present for images until persistence. */
  dataUrl?: string;
  /** Text file contents — present for text files until persistence. */
  textContent?: string;
}

export function isImageFileName(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
}

export function isTextFileName(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(extension);
}

export function formatAttachmentBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

function createAttachmentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

/**
 * Downscales/re-encodes an image through a canvas so stored base64 stays
 * small. Keeps the original payload when the source is already small enough;
 * otherwise re-encodes as JPEG (or PNG for images with alpha).
 */
async function compressImageFile(
  file: File,
): Promise<{ dataUrl: string; size: number; mimeType: string }> {
  const originalDataUrl = await readAsDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Invalid image: ${file.name}`));
    element.src = originalDataUrl;
  });

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
    return { dataUrl: originalDataUrl, size: file.size, mimeType: file.type || "image/png" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(`Failed to process image: ${file.name}`);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  // Only preserve PNG when transparency matters; JPEG keeps payloads compact.
  const hasAlpha = originalDataUrl.startsWith("data:image/png")
    || originalDataUrl.startsWith("data:image/webp");
  const mimeType = hasAlpha ? "image/png" : "image/jpeg";
  const quality = hasAlpha ? undefined : 0.85;
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const size = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
  return { dataUrl, size, mimeType };
}

/** Converts picked/dropped/pasted files into attachment drafts. */
export async function processFilesIntoAttachmentDrafts(
  files: File[],
): Promise<AIAttachmentDraft[]> {
  const drafts: AIAttachmentDraft[] = [];
  const now = Date.now();
  for (const file of files.slice(0, MAX_FILES_PER_TURN)) {
    const name = file.name || "clipboard-image";
    try {
      if (file.type.startsWith("image/") || isImageFileName(name)) {
        const compressed = await compressImageFile(file);
        drafts.push({
          id: createAttachmentId(),
          kind: "image",
          name,
          mimeType: compressed.mimeType,
          size: compressed.size,
          createdAt: now,
          dataUrl: compressed.dataUrl,
        });
        continue;
      }

      if (file.type.startsWith("text/") || isTextFileName(name) || file.type === "") {
        const text = await readAsText(file);
        drafts.push({
          id: createAttachmentId(),
          kind: "text",
          name,
          mimeType: file.type || "text/plain",
          size: file.size,
          createdAt: now,
          textContent: text.slice(0, MAX_TEXT_FILE_CHARS),
        });
        continue;
      }

      // Unknown binary: still store metadata so the manager can show it, but
      // there is nothing the model can read — it will not ride the request.
      drafts.push({
        id: createAttachmentId(),
        kind: "text",
        name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        createdAt: now,
        textContent: "",
      });
    } catch {
      // Skip unreadable files instead of failing the whole drop.
    }
  }
  return drafts;
}

/** Codex-style inline block for text file contents; images return nothing. */
export function buildAttachmentFileBlocks(drafts: AIAttachmentDraft[]) {
  const textDrafts = drafts.filter((draft) => draft.kind === "text" && draft.textContent?.trim());
  if (textDrafts.length === 0) return "";
  return textDrafts
    .map((draft) => `Attached file: ${draft.name}\n\`\`\`\n${draft.textContent!.trimEnd()}\n\`\`\``)
    .join("\n\n");
}

/** Maps drafts to the wire payload; only images ride the request body. */
export function toRequestAttachments(drafts: AIAttachmentDraft[]): AIRequestAttachment[] {
  return drafts
    .filter((draft) => draft.kind === "image" && draft.dataUrl)
    .map((draft) => ({
      kind: "image" as const,
      name: draft.name,
      mime_type: draft.mimeType,
      data: draft.dataUrl!.slice(draft.dataUrl!.indexOf(",") + 1),
    }));
}

const attachmentDataUrlCache = new Map<string, string>();

/** Memory guard: base64 payloads are large, so keep the cache bounded (LRU-ish
 *  by insertion order) instead of growing with every image ever viewed. */
const ATTACHMENT_DATA_URL_CACHE_MAX = 24;

function rememberAttachmentDataUrl(id: string, dataUrl: string) {
  attachmentDataUrlCache.set(id, dataUrl);
  if (attachmentDataUrlCache.size > ATTACHMENT_DATA_URL_CACHE_MAX) {
    const oldest = attachmentDataUrlCache.keys().next().value;
    if (oldest !== undefined && oldest !== id) {
      attachmentDataUrlCache.delete(oldest);
    }
  }
}

/** Resolves a persisted attachment id to a renderable data URL (cached). */
export async function fetchAttachmentDataUrl(id: string): Promise<string | null> {
  const cached = attachmentDataUrlCache.get(id);
  if (cached) return cached;
  try {
    const rows = await invokeMutation<{ id: string; mimeType: string; data: string }[]>(
      "get_ai_attachment_data",
      { ids: [id] },
    );
    const row = rows?.[0];
    if (!row) return null;
    const dataUrl = `data:${row.mimeType};base64,${row.data}`;
    rememberAttachmentDataUrl(id, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}
