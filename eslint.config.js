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
          selector: "Literal[value='toggle-query-schedules-palette']",
          message:
            "Use the APP_EVENTS constant from src/utils/app-events.ts instead of the raw channel string.",
        },
      ],
    },
  },
  {
    // The dispatch-channel registry is the one file allowed to spell the raw
    // strings — a per-file rule override instead of an ignore entry, because an
    // ignore makes lint-staged's explicit --fix invocation warn.
    files: ["src/utils/app-events.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
];
