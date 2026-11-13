#!/usr/bin/env node
/**
 * Translation review spreadsheets: one .xlsx per language for a native
 * speaker to review, and the import that brings their corrections back.
 *
 *   node scripts/translation-review.mjs export <lang|all> [dir]
 *     Write <dir>/Magnolia-<lang>-review.xlsx (dir defaults to
 *     translation-review/). Sheets: Read me (instructions, and the
 *     questions for this language from locales/GLOSSARY.md), Translations
 *     (key, where it appears, English, current translation, a column for
 *     the reviewer's correction and one for comments), Glossary (the
 *     terms table) and Stop words. Messages waiting for a translator
 *     (npm run i18n:sync) come first, with a Status column, and a Checked
 *     column for an English change the translation still fits.
 *
 *   node scripts/translation-review.mjs import <lang> <file.xlsx>
 *     Apply the Your correction column to src/renderer/locales/<lang>.json,
 *     and clear the pending messages translated or checked.
 *     A correction whose {{placeholders}} don't match the English is
 *     skipped and reported; comments and stop-word suggestions are
 *     printed for a person to act on. Run the tests afterwards
 *     (npm test checks every catalogue).
 *
 * The workbook is written and read with jszip (an .xlsx is a zip of XML),
 * so it opens in Excel, Numbers, LibreOffice and Google Sheets, and a copy
 * saved by any of them reads back in.
 */
import JSZip from 'jszip'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readStatus, writeStatus, baseKey } from './i18n-sync.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = path.join(ROOT, 'src/renderer/locales')
const PLURAL = /_(zero|one|two|few|many|other)$/

// ── Catalogues ─────────────────────────────────────────────────────

export const languages = () =>
  fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json') && f !== 'en.json').map((f) => f.slice(0, -5)).sort()

const readCatalogue = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'))

/** Every string in a catalogue, by dotted key, in file order. */
export function flatten(tree, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else flatten(v, key, out)
  }
  return out
}

function setKey(tree, key, value) {
  const parts = key.split('.')
  let node = tree
  for (const p of parts.slice(0, -1)) node = node[p] ??= {}
  node[parts.at(-1)] = value
}

/** The keys a language needs for an English message: the key itself, or
 *  one per plural form the language has. */
function keysFor(en, lang, base) {
  if (en.has(base)) return [base]
  return new Intl.PluralRules(lang).resolvedOptions().pluralCategories.map((f) => `${base}_${f}`)
}

export const placeholders = (s) => [...s.matchAll(/\{\{\s*(\w+)[^}]*\}\}/g)].map((m) => m[1]).sort()
const tags = (s) => [...s.matchAll(/<\/?[a-z]+>/g)].map((m) => m[0]).sort()

/** The English for a translated key: the same key, or for a plural form
 *  English lacks (few, many…) its "other" form. */
function englishFor(en, key) {
  if (en.has(key)) return en.get(key)
  const m = key.match(PLURAL)
  return m ? en.get(key.slice(0, -m[0].length) + (m[1] === 'one' ? '_one' : '_other')) : undefined
}

// ── Where a string appears ─────────────────────────────────────────

const WHERE = [
  ['native.menu', 'macOS menu bar'], ['native.dialog', 'Open and save dialogs'], ['native.import', 'Import error messages'],
  ['native.window', 'Window titles'], ['native.update', 'Update messages'], ['native.print', 'Printing error messages'],
  ['native.core', 'Messages when opening or saving a project'], ['language', 'Language menu in Preferences'],
  ['preferences', 'Preferences > General'], ['prefs', 'Preferences'], ['tools', 'Analysis tool names (Analyse tab)'],
  ['panes', 'Pane titles'], ['toolbar', 'Ribbon and toolbar'], ['project', 'Window title'], ['welcome', 'Welcome window'],
  ['update', 'Software Update window'], ['common', 'Buttons and labels used throughout'], ['panel', 'Pane buttons'],
  ['documents', 'Documents pane'], ['survey', 'Survey viewer'], ['tags', 'Tags'], ['codes', 'Codes pane'],
  ['queries', 'Saved Queries pane'], ['quotes', 'Saved Quotes pane'], ['memos', 'Memos (pane and window)'],
  ['analyses', 'Saved Analyses pane'], ['viewer', 'Document viewer'], ['tabs', 'Tabs'], ['notes', 'Notes (notebooks)'],
  ['media', 'Audio and video player'], ['transcript', 'Transcripts'], ['speakers', 'Speaker coding dialog'],
  ['memoFab', 'Memo button on queries and analyses'], ['checkout', '"Project in use" dialog'],
  ['stealBack', '"Project changed hands" dialog'], ['nameGate', 'First-run name prompt'], ['find', 'Find bar'],
  ['projectDetails', 'Project Details dialog'], ['licence', 'Licence dialog'], ['missing', 'Missing files banner'],
  ['memoEdit', 'Memo editor'], ['editor', 'Text formatting toolbar'], ['codebook', 'Codebook window'],
  ['logbook', 'Logbook window'], ['merge', 'Merge tool'], ['surveyImport', 'Survey import dialog'],
  ['queryBuilder', 'Query Builder'], ['queryDesc', 'Query descriptions'], ['results', 'Query Results pane'],
  ['scope', 'Choosing survey questions and respondents'], ['docSelector', 'Document Selector'],
  ['app', 'Progress and general messages'], ['analysis', 'Shared by the analysis tools'], ['words', 'Word Frequencies'],
  ['codesInDocs', 'Codes in Documents'], ['cooc', 'Code Co-Occurrences'], ['resultsInDocs', 'Results in Documents'],
  ['codeFreq', 'Code Frequencies'], ['codeOrders', 'Code Orders'], ['combos', 'Word Combinations'],
  ['framework', 'Framework Matrix'], ['reports', 'Reports'], ['map', 'Relationship map'],
  ['memoPlace', 'Where a memo is attached'], ['pdfText', 'Reading PDFs'], ['surveyParse', 'Reading survey files'],
  ['queryValidate', 'Query Builder errors'], ['platform', 'Keyboard and mouse names']
]

/** Numbers each plural category covers in a language, for the reviewer. */
function pluralExamples(lang) {
  const rules = new Intl.PluralRules(lang)
  const out = {}
  for (const n of [...Array(201).keys(), 1000, 1000000]) {
    const c = rules.select(n)
    ;(out[c] ??= []).length < 4 && out[c].push(n.toLocaleString('en'))
  }
  return out
}

function whereFor(key, examples) {
  const area = WHERE.find(([p]) => key === p || key.startsWith(p + '.'))?.[1] ?? ''
  const m = key.match(PLURAL)
  if (!m) return area
  const ex = examples[m[1]]
  return `${area} — plural form "${m[1]}"${ex ? ` (used for ${ex.join(', ')}…)` : ''}`
}

function notesFor(english) {
  const notes = []
  const ph = placeholders(english)
  if (ph.length) notes.push(`Keep ${[...new Set(ph)].map((p) => `{{${p}}}`).join(', ')} as written`)
  if (tags(english).length) notes.push('Keep the <b> tags around the same words')
  if (english.includes('\n')) notes.push('Keep the line breaks')
  return notes.join('. ')
}

// ── Glossary ───────────────────────────────────────────────────────

const LANGUAGE_NAMES = {
  es: 'Spanish', nl: 'Dutch', 'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)', ar: 'Arabic',
  fr: 'French', ru: 'Russian', 'zh-Hans': 'Chinese (Simplified)', it: 'Italian', hi: 'Hindi', de: 'German', fi: 'Finnish',
  sv: 'Swedish', nb: 'Norwegian (Bokmål)', da: 'Danish', tr: 'Turkish', ca: 'Catalan', cs: 'Czech',
  uk: 'Ukrainian', lt: 'Lithuanian', he: 'Hebrew', el: 'Greek', ja: 'Japanese'
}

/** The rows of a markdown table under `heading` in GLOSSARY.md. */
function glossaryTable(md, heading) {
  const start = md.indexOf(`## ${heading}`)
  if (start < 0) return []
  const rows = []
  for (const line of md.slice(start).split('\n').slice(1)) {
    if (line.startsWith('## ')) break
    if (!line.startsWith('|') || /^\|[-| ]+\|$/.test(line)) continue
    rows.push(line.slice(1, -1).split('|').map((c) => c.trim()))
  }
  return rows
}

function glossaryFor(lang) {
  const md = fs.readFileSync(path.join(LOCALES, 'GLOSSARY.md'), 'utf8')
  const name = LANGUAGE_NAMES[lang] ?? lang
  const pick = (table) => {
    const [head, ...rows] = table
    const col = head?.indexOf(name) ?? -1
    return col < 0 ? [] : rows.map((r) => [r[0], r[col] ?? ''])
  }
  const questions = md.slice(md.indexOf('## Questions for reviewers')).split('\n- ').slice(1)
    .map((q) => q.replace(/\s*\n\s*/g, ' ').replace(/\*\*/g, '').trim())
    .filter((q) => q.startsWith(name.split(' ')[0]) || (name.startsWith('Portuguese') && q.startsWith('European Portuguese') && lang === 'pt-PT') || (q.startsWith('French and Italian') && /French|Italian/.test(name)))
  return { conventions: pick(glossaryTable(md, 'Conventions')), terms: pick(glossaryTable(md, 'Terms')), questions, name }
}

function stopWordsFor(lang) {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Analysis/stop-words.ts'), 'utf8')
  const key = /^[a-z]+$/.test(lang) ? lang : `'${lang}'`
  const m = src.match(new RegExp(`\\n  ${key.replace(/[-']/g, (c) => '\\' + c)}: (?:PORTUGUESE \\+ )?[\`']([^\`']*)[\`']`))
  let words = m ? m[1] : ''
  if (/PORTUGUESE \+/.test(m?.[0] ?? '')) words = (src.match(/const PORTUGUESE = `([^`]*)`/)?.[1] ?? '') + ' ' + words
  return [...new Set(words.trim().split(/\s+/).filter(Boolean))]
}

// ── Writing an .xlsx ───────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
const colName = (i) => String.fromCharCode(65 + i)

/** A worksheet of rows (arrays of strings); row 0 is the header. `rtlCols`
 *  are cells whose text reads right to left. */
function sheetXml(rows, widths, rtlCols = []) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const style = r === 0 ? 1 : rtlCols.includes(c) ? 3 : 2
    return `<c r="${colName(c)}${r + 1}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(v ?? '')}</t></is></c>`
  }).join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${body}</sheetData></worksheet>`
}

export async function buildWorkbook(sheets) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F5"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf applyAlignment="1"><alignment vertical="top" wrapText="1" horizontal="right" readingOrder="2"/></xf></cellXfs></styleSheet>`)
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths, s.rtlCols)))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function exportLanguage(lang, dir) {
  const en = flatten(readCatalogue('en'))
  const tr = flatten(readCatalogue(lang))
  const examples = pluralExamples(lang)
  const rtl = new Intl.Locale(lang).maximize().script === 'Arab'
  const { conventions, terms, questions, name } = glossaryFor(lang)
  const pending = readStatus().pending[lang] ?? {}
  const waiting = Object.keys(pending).length > 0
  const rows = [waiting
    ? ['Key', 'Status', 'Where it appears', 'English', 'Current translation', 'Your correction', 'Checked (x)', 'Comment', 'Notes']
    : ['Key', 'Where it appears', 'English', 'Current translation', 'Your correction', 'Comment', 'Notes']]
  const row = (key, state) => {
    const english = englishFor(en, key) ?? ''
    const cells = [key, whereFor(key, examples), english, tr.get(key) ?? '', '', '', notesFor(english)]
    if (waiting) cells.splice(1, 0, state), cells.splice(6, 0, '')
    rows.push(cells)
  }
  // Waiting for a translator first, then everything else.
  for (const [base, state] of Object.entries(pending)) {
    const label = state === 'new' ? 'New: please translate' : `English changed (was "${state.was}"): correct the translation, or put x in Checked if it still fits`
    for (const key of keysFor(en, lang, base)) row(key, label)
  }
  for (const key of tr.keys()) {
    if (key.startsWith('language.name.')) continue // each language's own name
    if (!pending[baseKey(key)]) row(key, '')
  }
  const readme = [
    ['Magnolia translation review — ' + name],
    ['Thank you for reviewing Magnolia in ' + name + '. The Translations sheet lists every piece of interface text: the English, the current translation, and where it appears.'],
    ...(waiting ? [['The first rows are new or changed since the last review (see the Status column). Please translate the new ones, and check the changed ones: correct the translation, or put x in "Checked" if it still fits the new English.']] : []),
    ['Where a translation is wrong, unnatural or inconsistent, write your version in the "Your correction" column. Leave it empty where the translation is fine. Use "Comment" for anything else (a question, or a suggestion that needs discussion).'],
    ['Keep anything in {{double braces}} exactly as written, and keep <b>…</b> tags around the same words: Magnolia fills these in. The Notes column says when a row has them.'],
    ['Some rows are plural forms ("plural form one", "few", "many"…): the same message for different numbers. "Where it appears" lists the numbers each form is used for.'],
    ['The Glossary sheet lists the terms used throughout; if you change a term, please change it everywhere (or tell us, and we will). The Stop words sheet lists the common words left out of word counts.'],
    ...(questions.length ? [[''], ['Questions for you:'], ...questions.map((q) => ['• ' + q])] : [])
  ]
  const glossary = [['Convention / English term', name], ...conventions, ['', ''], ...terms]
  const stop = [['Stop word', 'Remove? (x)', 'Words to add (one per row)'], ...stopWordsFor(lang).map((w) => [w, '', ''])]
  const buf = await buildWorkbook([
    { name: 'Read me', rows: readme, widths: [120] },
    { name: 'Translations', rows, widths: waiting ? [34, 30, 38, 50, 50, 50, 10, 30, 30] : [34, 38, 50, 50, 50, 30, 30], rtlCols: rtl ? (waiting ? [4, 5] : [3, 4]) : [] },
    { name: 'Glossary', rows: glossary, widths: [40, 50], rtlCols: rtl ? [1] : [] },
    { name: 'Stop words', rows: stop, widths: [24, 14, 30], rtlCols: rtl ? [0, 2] : [] }
  ])
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `Magnolia-${lang}-review.xlsx`)
  fs.writeFileSync(file, buf)
  return { file, rows: rows.length - 1 }
}

// ── Reading an .xlsx ───────────────────────────────────────────────

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&')
/** The text of a string item: plain <t>, or rich-text runs. */
const itemText = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)].map((m) => unesc(m[1] ?? '')).join('')

/** Each sheet's rows, by sheet name, as arrays of cell strings. */
export async function readWorkbook(buf) {
  const zip = await JSZip.loadAsync(buf)
  const shared = []
  const ss = await zip.file('xl/sharedStrings.xml')?.async('string')
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(itemText(m[1]))
  const wb = await zip.file('xl/workbook.xml').async('string')
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  const target = (id) => rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`))?.[1]
  const out = {}
  for (const m of wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)) {
    const file = 'xl/' + target(m[2]).replace(/^\/?xl\//, '')
    const xml = await zip.file(file).async('string')
    const rows = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = c[1].match(/r="([A-Z]+)\d+"/)[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
        const type = c[1].match(/t="(\w+)"/)?.[1]
        const inner = c[2] ?? ''
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        cells[col] = type === 's' ? shared[+v] ?? '' : type === 'inlineStr' ? itemText(inner) : unesc(v ?? '')
      }
      rows.push(Array.from(cells, (x) => x ?? ''))
    }
    out[unesc(m[1])] = rows
  }
  return out
}

export async function importLanguage(lang, file) {
  const book = await readWorkbook(fs.readFileSync(file))
  const rows = book.Translations
  if (!rows) throw new Error('No "Translations" sheet in ' + file)
  const en = flatten(readCatalogue('en'))
  const catalogue = readCatalogue(lang)
  const current = flatten(catalogue)
  const status = readStatus()
  const pending = status.pending[lang] ?? {}
  const col = (name) => rows[0].indexOf(name)
  const [cCorrection, cComment, cChecked] = [col('Your correction'), col('Comment'), col('Checked (x)')]
  if (cCorrection < 0) throw new Error('No "Your correction" column in ' + file)
  const applied = [], skipped = [], comments = [], checked = new Set()
  for (const row of rows.slice(1)) {
    const key = row[0]
    const correction = row[cCorrection] ?? '', comment = cComment < 0 ? '' : row[cComment] ?? ''
    if (!key) continue
    if (comment.trim()) comments.push(`${key}: ${comment.trim()}`)
    if (cChecked >= 0 && row[cChecked]?.trim()) checked.add(baseKey(key))
    const text = correction.replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    const isNew = pending[baseKey(key)] === 'new' && keysFor(en, lang, baseKey(key)).includes(key)
    if (!current.has(key) && !isNew) { skipped.push(`${key}: no such key`); continue }
    const english = englishFor(en, key) ?? ''
    const form = key.match(PLURAL)?.[1]
    const inWords = (p) => ['zero', 'one', 'two'].includes(form) && p === 'count'
    const want = placeholders(english).filter((p) => !inWords(p))
    const got = placeholders(text).filter((p) => !inWords(p))
    if (want.join() !== got.join()) { skipped.push(`${key}: placeholders ${got.map((p) => `{{${p}}}`).join(' ') || '(none)'} don't match the English ${want.map((p) => `{{${p}}}`).join(' ') || '(none)'}`); continue }
    if (tags(english).join() !== tags(text).join()) { skipped.push(`${key}: the <b> tags don't match the English`); continue }
    checked.add(baseKey(key))
    if (text === current.get(key)) continue
    setKey(catalogue, key, text)
    applied.push(`${key}: ${current.get(key) ?? '(new)'}\n    → ${text}`)
  }
  // Clear what the reviewer translated or checked.
  const now = flatten(catalogue)
  const cleared = []
  for (const [base, state] of Object.entries(pending)) {
    const done = state === 'new' ? keysFor(en, lang, base).every((k) => now.has(k)) : checked.has(base)
    if (done) { delete pending[base]; cleared.push(base) }
  }
  if (cleared.length) writeStatus(status)
  const stop = book['Stop words'] ?? []
  const remove = stop.slice(1).filter((r) => r[0] && r[1]?.trim()).map((r) => r[0])
  const add = stop.slice(1).map((r) => r[2]?.trim()).filter(Boolean)
  if (applied.length) fs.writeFileSync(path.join(LOCALES, `${lang}.json`), JSON.stringify(catalogue, null, 2) + '\n')
  return { applied, skipped, comments, cleared, stopWords: { remove, add } }
}

// ── Command line ───────────────────────────────────────────────────

async function main([cmd, lang, arg]) {
  if (cmd === 'export' && lang) {
    const dir = path.resolve(arg ?? path.join(ROOT, 'translation-review'))
    for (const l of lang === 'all' ? languages() : [lang]) {
      const { file, rows } = await exportLanguage(l, dir)
      console.log(`${l}: ${rows} strings → ${path.relative(process.cwd(), file)}`)
    }
  } else if (cmd === 'import' && lang && arg) {
    const { applied, skipped, comments, cleared, stopWords } = await importLanguage(lang, arg)
    console.log(`Applied ${applied.length} correction(s) to ${lang}.json`)
    for (const a of applied) console.log('  ' + a)
    if (cleared.length) console.log(`\nNo longer waiting for a translator: ${cleared.join(', ')}`)
    if (skipped.length) { console.log(`\nSkipped ${skipped.length}:`); for (const s of skipped) console.log('  ' + s) }
    if (comments.length) { console.log(`\nComments:`); for (const c of comments) console.log('  ' + c) }
    if (stopWords.remove.length || stopWords.add.length) {
      console.log(`\nStop words (apply by hand in src/renderer/components/Analysis/stop-words.ts):`)
      if (stopWords.remove.length) console.log('  remove: ' + stopWords.remove.join(' '))
      if (stopWords.add.length) console.log('  add: ' + stopWords.add.join(' '))
    }
    console.log('\nNow run npm test, which checks every catalogue.')
  } else {
    console.log('Usage:\n  node scripts/translation-review.mjs export <lang|all> [dir]\n  node scripts/translation-review.mjs import <lang> <file.xlsx>')
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2))
