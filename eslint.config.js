import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist", "node_modules", "src-tauri/target"] },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
        React: "readonly",
        EventListener: "readonly",
        ScrollBehavior: "readonly",
      },
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // Disable React 19 / zustand patterns that trigger false positives
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/missing-exhaustive-deps": "off",
      "react-hooks/immutability": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "no-control-regex": "off",
      "no-param-assign": "off",
      "@typescript-eslint/no-parameter-properties": "off",
      "react-hooks/no-numeric-session-id": "off",
      "react-hooks/compilation-skipped": "off",
      "react-hooks/preserve-manual-memoization": "off",
      // Dispatch-channel names are contracts (a listener typo fails open), so
      // the raw string is only legal inside src/utils/app-events.ts — every
      // other site must import the APP_EVENTS constant.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(NewExpression[callee.name='CustomEvent'], CallExpression[callee.property.name=/^(addEventListener|removeEventListener)$/], CallExpression[callee.name=/^(addEventListener|removeEventListener)$/]) > Literal.arguments:first-child[value=/^(toggle-query-schedules-palette|table-data-updated|table-structure-updated|workspace-activity|schema-cache-invalidated|metrics-boards-updated|focus-metrics-widget|open-ai-slide-panel|open-ai-workspace-query|open-ai-metrics-board|open-ai-metrics-board-complete|open-ai-settings|open-left-sidebar-panel|insert-sql-from-ai|toggle-query-results-pane|focus-explorer-search|open-live-profiler|open-keyboard-shortcuts-palette|datagrid-undo|datagrid-redo|datagrid-duplicate-row|datagrid-fk-preview|format-sql-palette|focus-sql-editor-palette|focus-results-palette|open-sql-file-palette|import-sql-file-palette|clear-ai-history-palette|font-scale-changed|open-connection-form-palette|open-data-import-palette|open-schema-diff-palette|launcher-focus-connection)$/]",
          message:
            "Use EventCenter and APP_EVENTS from src/utils/app-events.ts instead of raw CustomEvent/addEventListener channels.",
        },
      ],
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["src/utils/app-events.ts", "src/stores/event-center.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
];
