// Lint: the React hooks rules (a hook's dependencies must be complete, or a
// stale closure can act on old state — the kind of bug that once let a
// window close without saving). TypeScript's own checks (strict, unused
// code) live in tsconfig.web.json.
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['out/**', 'target/**', 'node_modules/**', 'manual/**', 'working_materials/**', 'src-tauri/**'] },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  }
]
