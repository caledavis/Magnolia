# End-to-end tests

These run Magnolia itself and drive it as a user does: open a project, click
every number in the analysis tools, send the messages the other windows send,
code results, save, reopen. Unit tests (`npx vitest run`) check the pieces;
these check that the app, put together, does what it shows.

```sh
cargo build -p magnolia   # a development build: automation is compiled out of releases
npm run e2e               # every spec; or: node e2e/run.mjs analysis-tools
```

The runner starts the Vite dev server (or uses one already on port 5173),
then runs each spec in a test copy of Magnolia on a fresh copy of the sample
project, with settings of its own. A test copy never touches your projects or
settings, doesn't hand over to a Magnolia you have open, and on macOS works
behind your windows without taking the focus. `E2E_VERBOSE=1` prints every
check; `E2E_TIMEOUT` sets a spec's time limit in seconds (600).

- `run.mjs` — the runner.
- `harness.js` — runs in the app ahead of each spec: the toolkit (`t.check`,
  `t.module`, `t.press`, `t.until`, …) and the reporting. Any console error,
  React warning or uncaught error fails the spec.
- `specs/*.js` — one `async function spec(t)` each. A spec `foo.js` may have a
  `foo.after.js`, run next on the same project after it's reopened.
- `fixture/sample.qdpx` — the sample project: four interviews, a survey with
  closed and open-ended questions, codes, tags on documents, respondents and a
  question, a folder, saved queries, a memo. All made up. Rebuild it with
  `node e2e/run.mjs --make-fixture` (from `fixture/make-sample.js`) when the
  project format changes.

Timing on a large project (not part of the suite): `node e2e/run.mjs
--make-large` builds `perf/large.qdpx` (made up; not kept in git), and
`E2E_VERBOSE=1 node e2e/run.mjs --perf` times opening, saving, queries, the
analysis tools, documents and the survey's views on it, with the longest the
window stopped responding during each.

On GitHub the suite runs on macOS, Windows and Linux (on a virtual display)
after the build (`.github/workflows/build.yml`).
