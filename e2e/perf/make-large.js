// Builds e2e/perf/large.qdpx (node e2e/run.mjs --make-large): a large,
// made-up project for timing the app. 300 interviews of about 15,000
// characters, a 300,000-character transcript, a survey of 1,000
// respondents with three open-ended questions, about 10,000 codings, tags
// on documents and respondents. The same every time (a seeded generator).

const DOCUMENTS = 300
const DOCUMENT_CHARS = 15000
const TRANSCRIPT_CHARS = 300000
const RESPONDENTS = 1000
const CODINGS_PER_DOCUMENT = 30

function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(20261124)
const pick = (list) => list[Math.floor(random() * list.length)]

const SUBJECTS = ['I', 'My flatmate', 'Our tutor', 'The course', 'My family', 'Everyone in my group', 'The university', 'My manager at work']
const VERBS = ['worries about', 'talks about', 'never mentions', 'struggles with', 'helps with', 'jokes about', 'thinks a lot about', 'avoids']
const OBJECTS = ['the rent', 'student debt', 'group projects', 'feeling alone', 'the library', 'mental health', 'long shifts', 'exam stress', 'friends from home', 'the travel', 'clinical placements', 'the fees']
const ENDINGS = ['every week.', 'more than I expected.', 'when deadlines come.', 'at the end of the month.', 'since the first term.', 'most days.']
const sentence = () => `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(ENDINGS)}`
function text(chars, speakers) {
  let out = ''
  while (out.length < chars) {
    out += speakers ? `${pick(speakers)}: ` : ''
    for (let i = 0; i < 4; i++) out += sentence() + ' '
    out = out.trimEnd() + '\n'
  }
  return out
}

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tags = (await t.module('stores/tag-store')).useTagStore
  const project = (await t.module('stores/project-store')).useProjectStore
  const { parseSurveyCsv } = await t.module('utils/survey/survey-parser')
  const { buildCellText } = await t.module('utils/survey/cell-text')
  const started = performance.now()

  const parents = ['Money', 'Wellbeing', 'Belonging', 'Study', 'Work'].map((name) => codes.getState().addCode(name, '#888888'))
  const codeGuids = [...parents]
  for (const p of parents) for (let i = 1; i <= 4; i++) codeGuids.push(codes.getState().addCode(`Sub ${i}`, '#AAAAAA', p))

  /** Code random sentence-sized passages of `body`. */
  const codeRandomly = (guid, body, count, cell) => {
    const length = Array.from(body).length
    for (let i = 0; i < count; i++) {
      const start = Math.floor(random() * Math.max(1, length - 200))
      const end = Math.min(length, start + 20 + Math.floor(random() * 180))
      const sel = docs.getState().addSelection(guid, start, end, '', undefined, cell)
      docs.getState().addCodingToSelection(guid, sel, pick(codeGuids))
      if (random() < 0.3) docs.getState().addCodingToSelection(guid, sel, pick(codeGuids))
    }
  }

  const documents = []
  for (let d = 0; d < DOCUMENTS; d++) {
    const body = text(DOCUMENT_CHARS, ['Interviewer', 'Participant'])
    const guid = docs.getState().addSource(`Interview ${String(d + 1).padStart(3, '0')}.txt`, body, 'text')
    codeRandomly(guid, body, CODINGS_PER_DOCUMENT)
    documents.push(guid)
  }
  const transcript = text(TRANSCRIPT_CHARS, ['Facilitator', 'A', 'B', 'C', 'D'])
  codeRandomly(docs.getState().addSource('Focus group transcript.txt', transcript, 'text'), transcript, 400)

  const rows = [
    ['RespondentID', 'Student type', 'What is hardest?', 'What helps?', 'Anything else?'],
    ['', 'Response', 'Open-Ended Response', 'Open-Ended Response', 'Open-Ended Response']
  ]
  for (let r = 0; r < RESPONDENTS; r++) rows.push([String(100000 + r), r % 2 ? 'International' : 'Domestic', sentence() + ' ' + sentence(), sentence(), random() < 0.5 ? sentence() : ''])
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n'
  const survey = parseSurveyCsv(csv, 'Big survey')
  const surveyGuid = docs.getState().addSource('Big survey', csv, 'survey', { survey, rawCsv: csv })
  const open = survey.questions.filter((q) => q.type === 'open-ended')
  for (const r of survey.respondents) {
    for (const q of open) {
      const answer = buildCellText(r.answers[q.id])
      if (answer && random() < 0.5) codeRandomly(surveyGuid, answer, 1, { respondentId: r.id, questionId: q.id })
    }
  }

  const category = tags.getState().createCategory('Student type', 'text')
  const domestic = tags.getState().createTag('Domestic', category, 'Domestic')
  const international = tags.getState().createTag('International', category, 'International')
  documents.forEach((g, i) => tags.getState().assignTagToDocument(i % 2 ? international : domestic, g))
  survey.respondents.forEach((r, i) => tags.getState().assignTagToSurveyRespondent(i % 2 ? international : domestic, surveyGuid, r.id))

  const codings = docs.getState().sources.reduce((n, s) => n + s.selections.reduce((m, sel) => m + sel.codings.length, 0), 0)
  t.log(`built ${docs.getState().sources.length} documents, ${codings} codings in ${Math.round(performance.now() - started)} ms`)
  t.check('the project has its documents', docs.getState().sources.length === DOCUMENTS + 2)

  const saveStart = performance.now()
  project.getState().markDirty()
  t.check('the large project saved', !!(await t.until(() => !project.getState().isDirty, 300000)))
  t.log(`saved in ${Math.round(performance.now() - saveStart)} ms`)
}
