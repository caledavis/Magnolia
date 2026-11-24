// Builds e2e/fixture/sample.qdpx in the app (node e2e/run.mjs
// --make-fixture): four short interviews, a survey with closed and
// open-ended questions, codes (with subcodes) applied by phrase, including
// passages with two codes and codings that overlap, tags on documents, on
// survey respondents and on a question, a folder, saved queries and a memo.
// Everything in it is made up.

const INTERVIEWS = [
  {
    name: 'Interview - Ana.txt',
    text:
      'Interviewer: How has the year been?\n' +
      'Ana: Honestly the rent is the hardest part. I work two jobs to cover the rent and my student debt keeps growing. ' +
      'Some weeks I feel completely exhausted and alone. My flatmates help, though, and the study group makes me feel I belong here.\n' +
      "Interviewer: What would help?\n" +
      "Ana: Cheaper housing near campus. And the students' union could run more social events.",
    codes: [
      ['the rent is the hardest part', ['Rent']],
      ['I work two jobs to cover the rent and my student debt keeps growing', ['Rent', 'Debt']],
      ['I feel completely exhausted and alone', ['Wellbeing']],
      ['the study group makes me feel I belong here', ['Belonging']],
      ['Cheaper housing near campus', ['Rent']]
    ]
  },
  {
    name: 'Interview - Ben.txt',
    text:
      'Interviewer: Tell me about money.\n' +
      'Ben: The debt worries me every day. I skip meals at the end of the month, and that affects my mood and my sleep.\n' +
      'Interviewer: Do you feel part of the university?\n' +
      "Ben: Not really. I don't know anyone in my course, and I study from home most days.",
    codes: [
      ['The debt worries me every day', ['Debt', 'Wellbeing']],
      ['I skip meals at the end of the month', ['Money']],
      ['that affects my mood and my sleep', ['Wellbeing']],
      ["I don't know anyone in my course", ['Belonging']]
    ]
  },
  {
    name: 'Interview - Chen.txt',
    text:
      'Interviewer: How did you find moving here?\n' +
      'Chen: As an international student the fees are very high, and the rent is high too. ' +
      'At first I felt alone, but the international students society gave me friends quickly.\n' +
      'Interviewer: And your studies?\n' +
      'Chen: Group projects are hard when everyone works different hours, but my tutor checks in on my wellbeing.',
    codes: [
      ['the fees are very high, and the rent is high too', ['Debt', 'Rent']],
      ['At first I felt alone', ['Wellbeing']],
      ['the international students society gave me friends quickly', ['Belonging']],
      ['my tutor checks in on my wellbeing', ['Wellbeing', 'Belonging']]
    ]
  },
  {
    name: 'Interview - Dee.txt',
    text:
      'Interviewer: You came back to study later in life?\n' +
      'Dee: Yes, with two children. Paying for childcare and books means the money never stretches. ' +
      'I feel older than the others and rarely join in, but the mature students meet each Friday.',
    codes: [
      ['Paying for childcare and books means the money never stretches', ['Money']],
      ['I feel older than the others and rarely join in', ['Belonging', 'Wellbeing']],
      ['the mature students meet each Friday', ['Belonging']]
    ]
  }
]

// SurveyMonkey's layout: question text in row 1, "Response" (closed) or
// "Open-Ended Response" in row 2.
const SURVEY_NAME = 'Student Survey'
const SURVEY_ROWS = [
  ['RespondentID', 'Student type', 'What is hardest about studying?', 'What helps you most?'],
  ['', 'Response', 'Open-Ended Response', 'Open-Ended Response'],
  ['1001', 'Domestic', 'Paying rent while studying full time.', 'My friends in the study group.'],
  ['1002', 'Domestic', 'Debt and feeling alone at night.', 'Talking to my tutor about my wellbeing.'],
  ['1003', 'Domestic', 'Travelling two hours each way.', 'Online lectures I can watch later.'],
  ['1004', 'Domestic', 'Nothing much, it is going well.', 'The library and quiet rooms.'],
  ['1005', 'International', 'High fees and the rent.', 'The international students society.'],
  ['1006', 'International', 'Feeling alone in a new country.', 'Friends from my course.'],
  ['1007', 'International', 'Understanding the marking.', 'Writing workshops.'],
  ['1008', 'International', 'Working nights to pay rent.', 'Domestic students who invite me out.']
]
const SURVEY_CODES = [
  ['Paying rent while studying full time', ['Rent']],
  ['Debt', ['Debt']],
  ['feeling alone at night', ['Wellbeing']],
  ['Talking to my tutor about my wellbeing', ['Wellbeing', 'Belonging']],
  ['My friends in the study group', ['Belonging']],
  ['High fees and the rent', ['Debt', 'Rent']],
  ['Feeling alone in a new country', ['Wellbeing', 'Belonging']],
  ['Friends from my course', ['Belonging']],
  ['Working nights to pay rent', ['Rent']],
  ['The international students society', ['Belonging']]
]

const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tags = (await t.module('stores/tag-store')).useTagStore
  const memos = (await t.module('stores/memo-store')).useMemoStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const project = (await t.module('stores/project-store')).useProjectStore
  const { parseSurveyCsv } = await t.module('utils/survey/survey-parser')
  const { buildCellText } = await t.module('utils/survey/cell-text')

  // Codes: Money (Debt, Rent), Wellbeing, Belonging.
  const code = {}
  code.Money = codes.getState().addCode('Money', '#E5674B')
  code.Debt = codes.getState().addCode('Debt', '#F2A65A', code.Money)
  code.Rent = codes.getState().addCode('Rent', '#C94C4C', code.Money)
  code.Wellbeing = codes.getState().addCode('Wellbeing', '#4C9F70')
  code.Belonging = codes.getState().addCode('Belonging', '#3D7DCA')

  /** Code each phrase where it occurs in `text` (first occurrence). */
  const applyCodes = (sourceGuid, text, list, surveyCell) => {
    for (const [phrase, names] of list) {
      const at = text.indexOf(phrase)
      if (at < 0) continue
      const start = Array.from(text.slice(0, at)).length
      const end = start + Array.from(phrase).length
      const sel = docs.getState().addSelection(sourceGuid, start, end, phrase, undefined, surveyCell)
      for (const n of names) docs.getState().addCodingToSelection(sourceGuid, sel, code[n])
    }
  }

  const interview = {}
  for (const i of INTERVIEWS) {
    const guid = docs.getState().addSource(i.name, i.text, 'text')
    interview[i.name.replace(/^Interview - |\.txt$/g, '')] = guid
    applyCodes(guid, i.text, i.codes)
  }

  // The survey, parsed as an import parses it.
  const csv = SURVEY_ROWS.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
  const survey = parseSurveyCsv(csv, SURVEY_NAME)
  const surveyGuid = docs.getState().addSource(SURVEY_NAME, csv, 'survey', { survey, rawCsv: csv })
  const openEnded = survey.questions.filter((q) => q.type === 'open-ended')
  t.check('the survey has one closed and two open-ended questions', survey.questions.length === 3 && openEnded.length === 2,
    survey.questions.map((q) => q.type).join(', '))
  t.check('the survey has eight respondents', survey.respondents.length === 8)
  for (const r of survey.respondents) {
    for (const q of openEnded) {
      const text = buildCellText(r.answers[q.id])
      applyCodes(surveyGuid, text, SURVEY_CODES, { respondentId: r.id, questionId: q.id })
    }
  }

  // Tags: Student type (Domestic, International, Mature), on interviews
  // and on survey respondents; "Followed up" on a respondent and a
  // question of the same survey.
  const ts = tags.getState()
  const studentType = ts.createCategory('Student type', 'text')
  const domestic = ts.createTag('Domestic', studentType, 'Domestic')
  const international = ts.createTag('International', studentType, 'International')
  const mature = ts.createTag('Mature', studentType, 'Mature')
  const followedUp = ts.createTag('Followed up')
  for (const n of ['Ana', 'Ben']) tags.getState().assignTagToDocument(domestic, interview[n])
  tags.getState().assignTagToDocument(international, interview.Chen)
  tags.getState().assignTagToDocument(mature, interview.Dee)
  survey.respondents.forEach((r, i) => tags.getState().assignTagToSurveyRespondent(i < 4 ? domestic : international, surveyGuid, r.id))
  tags.getState().assignTagToSurveyRespondent(followedUp, surveyGuid, survey.respondents[1].id)
  tags.getState().assignTagToSurveyQuestion(followedUp, surveyGuid, openEnded[1].id)

  // A folder with two interviews.
  const round1 = docs.getState().addFolder('Round 1')
  docs.getState().moveSourceToFolder(interview.Ana, round1)
  docs.getState().moveSourceToFolder(interview.Ben, round1)

  // Saved queries: one plain, one under a tag filter.
  queries.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'code', codeGuid: code.Money, includeSubcodes: true } })
  queries.getState().saveCurrentQuery('Money talk')
  queries.getState().setComplexQuery({ documentFilter: { tagGuids: [domestic] }, codeCondition: { type: 'code', codeGuid: code.Wellbeing } })
  queries.getState().saveCurrentQuery('Domestic wellbeing')
  queries.getState().clearQuery()

  memos.getState().addMemo('project', 'About this project', { content: 'A made-up project for Magnolia’s end-to-end tests.' })

  const codings = docs.getState().sources.reduce((n, s) => n + s.selections.reduce((m, sel) => m + sel.codings.length, 0), 0)
  // 21 codings in the interviews, 13 in the survey's answers.
  t.check('the project has its documents and codings', docs.getState().sources.length === 5 && codings === 34, `${docs.getState().sources.length} documents, ${codings} codings`)

  // Saved as any project is: by the autosave.
  project.getState().markDirty()
  const saved = await t.until(() => !project.getState().isDirty, 20000)
  t.check('the project saved', !!saved)
}
