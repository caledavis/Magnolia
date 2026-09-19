import { defineConfig } from 'vitest/config'

// Node-environment unit tests (the REFI-QDA serializer/deserializer live in
// the main process and have no DOM). Test files live under test/.
export default defineConfig({
  // project-store.ts references __APP_VERSION__, a global normally injected
  // by electron.vite.config.ts's renderer.define — stub it here too so
  // tests that import renderer stores (e.g. for the merge apply engine)
  // don't need Electron's own build config.
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test')
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
