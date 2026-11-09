/**
 * The project the layout checks open: a few short made-up interviews,
 * coded, with tags, a saved query and a memo. run.mjs writes it as a
 * .qdpx with Magnolia's own writer (the qdpx_tool example in
 * crates/magnolia-core), so it always matches the current format.
 */

let n = 0
const id = () => `00000000-0000-4000-8000-${(++n).toString(16).toUpperCase().padStart(12, '0')}`
const WHEN = '2026-01-15T10:00:00.000Z'

/** Names the checks look for (run.mjs passes them to checks.js). */
export const NAMES = { document: 'Interview 1.txt', code: 'Workload', query: 'Workload and support' }

const INTERVIEWS = {
  'Interview 1.txt': `Participant 1 | first year | full time

How has the first semester been?

Busy. The workload is heavier than I expected, especially the weekly readings. I work two evenings a week as well, so most weekends go on assignments.

Who do you turn to when it gets too much?

My tutor has been really supportive. She answers emails quickly and the drop-in sessions helped me with referencing. I also lean on a study group from my first class.`,
  'Interview 2.txt': `Participant 2 | third year | part time

What's changed since you started?

I moved to part time because of my job. The workload feels manageable now, but I miss being on campus. Most of my classes are online, which suits my hours but can be lonely.

Is there support you'd like more of?

Honestly, careers advice. The library staff are great, and the online support is quick, but nobody has talked to me about what comes after the degree.`,
  'Interview 3.txt': `Participant 3 | second year | full time

What does a typical week look like?

Lectures three days, a placement on Thursdays and the rest is study. The placement is unpaid, so money is tight and the workload adds up.

What helps?

Friends from the student society. We cook together on Sundays and plan the week. Without them I think I would have left in first year.`
}

const CODES = [
  { name: 'Study', color: '#E5674B', children: [
    { name: 'Workload', color: '#EC927D', phrases: ['The workload is heavier than I expected, especially the weekly readings', 'The workload feels manageable now', 'the workload adds up'] },
    { name: 'Studying online', color: '#F0B2A3', phrases: ['Most of my classes are online, which suits my hours but can be lonely'] }
  ] },
  { name: 'Support', color: '#5B8DEF', children: [
    { name: 'Staff', color: '#8FB0F3', phrases: ['My tutor has been really supportive', 'The library staff are great, and the online support is quick'] },
    { name: 'Friends and peers', color: '#B9CDF7', phrases: ['I also lean on a study group from my first class', 'Friends from the student society'] }
  ] },
  { name: 'Money and work', color: '#4CAF8E', phrases: ['I work two evenings a week as well', 'I moved to part time because of my job', 'The placement is unpaid, so money is tight'] }
]

/** The project and its text, as qdpx_tool write takes them. */
export function fixture() {
  n = 0
  const user = id()
  const sources = Object.entries(INTERVIEWS).map(([name, text]) => ({ guid: id(), name, text, selections: [] }))
  const codes = []
  const codeGuid = {}
  const makeCode = (c) => {
    const guid = id()
    codeGuid[c.name] = guid
    for (const phrase of c.phrases ?? []) {
      const source = sources.find((s) => s.text.includes(phrase))
      if (!source) throw new Error('No interview has: ' + phrase)
      const start = source.text.indexOf(phrase)
      source.selections.push({
        guid: id(), startPosition: start, endPosition: start + phrase.length,
        creatingUser: user, creationDateTime: WHEN, modifyingUser: '',
        codings: [{ guid: id(), codeGuid: guid, creatingUser: user, creationDateTime: WHEN }]
      })
    }
    return { guid, name: c.name, isCodable: true, color: c.color, description: '', children: (c.children ?? []).map(makeCode) }
  }
  for (const c of CODES) codes.push(makeCode(c))

  const year = { guid: id(), name: 'Year', type: 'text' }
  const tag = (value, names) => ({
    guid: id(), name: value, value, categoryGuid: year.guid, memberCodeGuids: [], memberSurveyRespondents: [],
    memberSourceGuids: sources.filter((s) => names.includes(s.name)).map((s) => s.guid)
  })
  const workload = codeGuid.Workload, staff = codeGuid.Staff
  const project = {
    name: 'Layout check',
    origin: 'Magnolia layout check',
    description: 'Made-up interviews for checking the interface layout.',
    creatingUserGUID: user, creationDateTime: WHEN, modifyingUserGUID: '', modifiedDateTime: WHEN,
    users: [{ guid: user, name: 'Tester' }],
    codes,
    sources: sources.map(({ guid, name, selections }) => ({
      guid, name, plainTextPath: `internal://${guid}.txt`, creatingUser: user, creationDateTime: WHEN, modifyingUser: '', selections
    })),
    folders: [], sourceFolder: {}, quotes: [], notes: [], savedAnalyses: [],
    tagCategories: [year],
    sets: [tag('First year', ['Interview 1.txt']), tag('Later years', ['Interview 2.txt', 'Interview 3.txt'])],
    savedQueries: [{
      guid: id(), name: NAMES.query, createdDateTime: WHEN,
      query: {
        documentFilter: {
          sourceGuids: sources.map((s) => s.guid),
          graph: { nodes: [{ id: 'd1', kind: 'allDocs', x: 120, y: 130 }, { id: 'result', kind: 'result', x: 520, y: 130 }], conns: [{ id: 'd2', from: 'd1', to: 'result', toPort: 0 }] }
        },
        codeCondition: { type: 'or', conditions: [{ type: 'code', codeGuid: workload }, { type: 'code', codeGuid: staff }] }
      },
      graphLayout: {
        nodes: [
          { id: 'result', kind: 'result', x: 580, y: 170 },
          { id: 'q1', kind: 'logical', logicalOp: 'or', inputCount: 2, x: 320, y: 140 },
          { id: 'q2', kind: 'code', x: 110, y: 100, codeGuid: workload, codeName: 'Workload', codeColor: '#EC927D' },
          { id: 'q3', kind: 'code', x: 110, y: 230, codeGuid: staff, codeName: 'Staff', codeColor: '#8FB0F3' }
        ],
        conns: [{ id: 'q4', from: 'q2', to: 'q1', toPort: 0 }, { id: 'q5', from: 'q3', to: 'q1', toPort: 1 }, { id: 'q6', from: 'q1', to: 'result', toPort: 0 }]
      }
    }],
    memos: [{ guid: id(), type: 'project', title: 'First impressions', createdDateTime: WHEN, content: 'Workload comes up in every interview; support mostly comes from people, not services.' }]
  }
  return { project, sourceContents: Object.fromEntries(sources.map((s) => [s.guid, s.text])) }
}
