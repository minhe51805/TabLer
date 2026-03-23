// Store exports - components can migrate to individual stores over time:
// - import { useConnectionStore } from "./stores/connectionStore"
// - import { useQueryStore } from "./stores/queryStore"
// - import { useAIStore } from "./stores/aiStore"
// - import { useUIStore } from "./stores/uiStore"
//
// For backward compatibility, continue importing from "./stores/appStore":
//   import { useAppStore } from "./stores/appStore"

export { useConnectionStore } from "./connectionStore";
export { useQueryStore } from "./queryStore";
export { useAIStore } from "./aiStore";
export { useUIStore } from "./uiStore";

// Re-export from appStore (monolithic - kept for backward compatibility)
export { useAppStore } from "./appStore";

// Shared utilities
export { deriveConnectionName } from "./connectionStore";
