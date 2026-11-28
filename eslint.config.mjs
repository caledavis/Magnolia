// Lint: the React hooks rules (a hook's dependencies must be complete, or a
// stale closure can act on old state — the kind of bug that once let a
// window close without saving), and no floating promises (an async call
// whose rejection nobody handles fails silently — the kind of bug that left
// PDF pages without their text layer; mark a deliberate fire-and-forget with
// `void`). TypeScript's own checks (strict, unused code) live in
// tsconfig.web.json.
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['out/**', 'target/**', 'node_modules/**', 'manual/**', 'working_materials/**', 'src-tauri/**'] },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: './tsconfig.web.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-floating-promises': 'error'
    }
  }
]
