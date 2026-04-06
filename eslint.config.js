import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  { ignores: ['dist', 'node_modules', 'src-tauri/target'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
        React: 'readonly',
        EventListener: 'readonly',
        ScrollBehavior: 'readonly',
      },
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Disable React 19 / zustand patterns that trigger false positives
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/missing-exhaustive-deps': 'off',
      'react-hooks/immutability': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-control-regex': 'off',
      'no-param-assign': 'off',
      '@typescript-eslint/no-parameter-properties': 'off',
      'react-hooks/no-numeric-session-id': 'off',
      'react-hooks/compilation-skipped': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
]
