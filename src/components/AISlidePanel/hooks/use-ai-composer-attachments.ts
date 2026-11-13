import { useCallback, useRef } from "react";
import type { getAIWorkspaceCopy } from "../ai-workspace-copy";
import {
  MAX_IMAGES_PER_TURN,
  processFilesIntoAttachmentDrafts,
} from "../../../utils/ai-attachments";
import { useAIPanelStore } from "../store/aiPanelStore";

interface ComposerProvider {
  model?: string;
  model_settings?: Record<string, { input_types?: string[] } | undefined>;
}

interface UseAIComposerAttachmentsOptions {
  activeProvider: ComposerProvider | null | undefined;
  aiCopy: ReturnType<typeof getAIWorkspaceCopy>;
  setError: (message: string | null) => void;
}

/**
 * Composer attachment intake: files become drafts in `useAIPanelStore` with
 * dedupe by kind/name/size, a hard cap on images per turn, and a one-time-per-model
 * warning when the active model does not advertise image input.
 */
export function useAIComposerAttachments({
  activeProvider,
  aiCopy,
  setError,
}: UseAIComposerAttachmentsOptions) {
  const setComposerAttachments = useAIPanelStore((state) => state.setComposerAttachments);

  const canAttachImages = Boolean(
    activeProvider?.model &&
    activeProvider?.model_settings?.[activeProvider.model]?.input_types?.includes("image"),
  );
  const imageWarningModelRef = useRef<string | null>(null);

  const handleAddComposerAttachmentFiles = useCallback(
    async (files: File[]) => {
      const drafts = await processFilesIntoAttachmentDrafts(files);
      if (drafts.length === 0) return;
      const incomingImages = drafts.filter((draft) => draft.kind === "image").length;
      const existingImages = useAIPanelStore
        .getState()
        .composerAttachments.filter((draft) => draft.kind === "image").length;
      const imageOverflow = incomingImages + existingImages > MAX_IMAGES_PER_TURN;
      setComposerAttachments((current) => {
        const existing = new Set(
          current.map((draft) => `${draft.kind}:${draft.name}:${draft.size}`),
        );
        const merged = [...current];
        let imageCount = current.filter((draft) => draft.kind === "image").length;
        drafts.forEach((draft) => {
          if (draft.kind === "image" && imageCount >= MAX_IMAGES_PER_TURN) return;
          const key = `${draft.kind}:${draft.name}:${draft.size}`;
          if (!existing.has(key)) {
            existing.add(key);
            if (draft.kind === "image") imageCount += 1;
            merged.push(draft);
          }
        });
        return merged;
      });
      if (imageOverflow) {
        setError(aiCopy.attachments.imageLimit);
      } else if (
        !canAttachImages &&
        incomingImages > 0 &&
        imageWarningModelRef.current !== (activeProvider?.model ?? "")
      ) {
        imageWarningModelRef.current = activeProvider?.model ?? "";
        setError(aiCopy.attachments.imageMaybeUnsupported);
      }
    },
    [
      activeProvider?.model,
      aiCopy.attachments.imageLimit,
      aiCopy.attachments.imageMaybeUnsupported,
      canAttachImages,
      setComposerAttachments,
      setError,
    ],
  );

  const handleRemoveComposerAttachment = useCallback(
    (id: string) => {
      setComposerAttachments((current) => current.filter((draft) => draft.id !== id));
    },
    [setComposerAttachments],
  );

  return {
    canAttachImages,
    handleAddComposerAttachmentFiles,
    handleRemoveComposerAttachment,
  };
}
