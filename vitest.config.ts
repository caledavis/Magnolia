import { defineConfig } from 'vitest/config'

// Node-environment unit tests for renderer logic (stores, query engine,
// merge). Test files live under test/; the Rust backend's tests run with
// `cargo test --workspace`.
export default defineConfig({
  // project-store.ts references __APP_VERSION__, a global normally injected
  // by vite.config.ts's define — stub it here too so tests that import
  // renderer stores (e.g. for the merge apply engine) don't need the app's
  // build config.
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test')
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
