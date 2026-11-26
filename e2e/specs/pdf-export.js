// A report is exported as a PDF, which is written to disk (GitHub #38: on
// Linux with the system in another language, none was, without a word).
// The build machine runs this on Linux a second time in Spanish.

async function spec(t) {
  const { exportReportPdf } = await t.module('components/Analysis/report-export')
  const path = await exportReportPdf('Export test', [{ id: 'a', kind: 'text', content: 'hola' }])
  t.check('the report is written as a PDF', typeof path === 'string' && /Export test\.pdf$/.test(path), String(path))
}
