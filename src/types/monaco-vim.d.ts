declare module "monaco-vim" {
  export interface VimAdapterInstance {
    dispose(): void;
  }

  export function initVimMode(
    editor: unknown,
    statusbarNode?: HTMLElement | null,
  ): VimAdapterInstance;
}
