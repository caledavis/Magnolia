# Translation glossary

Magnolia's interface text lives in one catalogue per language in this
folder: `en.json` (the source), `es.json` (Spanish), `nl.json` (Dutch) and
`pt-BR.json` (Brazilian Portuguese). The renderer reads them through
i18next (`src/renderer/i18n`); the Rust backend reads the `native` section
for its menus, file dialogs, window titles and update messages
(`src-tauri/src/i18n.rs`).

Every key in `en.json` must exist in the other catalogues, with the same
`{{placeholders}}` (`test/renderer/i18n-catalogues.test.ts` checks this).
Plural strings use i18next's suffixes: `_one` and `_other`, plus `_many`
in Spanish and Portuguese (CLDR uses it for millions, "1 millón de
códigos"), and all six (`_zero`, `_one`, `_two`, `_few`, `_many`,
`_other`) in Arabic, whose zero, one and two forms usually name the
number in words ("رمزان", two codes).

Numbers, percentages, dates and times are written by the code in each
language's own way (`formatNumber`, `formatPercent`, `formatDateTime` in
`src/renderer/i18n`): a number put into a message arrives as "1,234" or
"1.234", and a percentage arrives with its % sign. So a translation never
adds a % sign or separators of its own. CSV exports keep plain "12.5"
decimals, which spreadsheets read in any language.

The translations were drafted by Claude and need review by native
speakers before release, as do the stop-word lists (the common words Word
Frequencies and Word Combinations leave out) in
`src/renderer/components/Analysis/stop-words.ts`. Keep to the terms below so the interface uses
one word for each idea; change a term here first, then everywhere.

## Conventions

| | Spanish | Dutch | Portuguese (Brazil) | Arabic |
|---|---|---|---|---|
| Address the user as | *tú* | *je* | *você* | Commands as verbal nouns ("حفظ"), so no gender; sentences in the masculine singular where unavoidable |
| Capitalisation | Sentence case | Sentence case | Sentence case | — |
| Menu commands | Infinitive: "Guardar proyecto" | Imperative, as on macOS: "Bewaar project" | Infinitive: "Salvar projeto" | Verbal noun: "حفظ المشروع" |
| Buttons and tooltips | Infinitive: "Importar" | Infinitive, as in Office: "Importeren" | Infinitive: "Importar" | Verbal noun: "استيراد" |
| Quotation marks | « » | " " | " " | “ ” (and « » around interface names) |
| The app's name | Magnolia | Magnolia | o Magnolia (masculine, like "o aplicativo") | Magnolia, in Latin letters |
| Query operators | AND, OR, NOT, XOR stay in English, as query syntax; their explanations are translated | same | same | same |

## Terms

| English | Spanish | Dutch | Portuguese (Brazil) | Arabic |
|---|---|---|---|---|
| analysis (a saved analysis) | análisis | analyse | análise | تحليل |
| box selection | selección de recuadro | kaderselectie | seleção de caixa | تحديد مربع |
| code (noun) | código | code | código | رمز (ج. رموز) |
| code (verb), coding | codificar, codificación | coderen, codering | codificar, codificação | رمّز، ترميز |
| coded segment | segmento codificado | gecodeerd segment | segmento codificado | مقطع مرمّز |
| codebook | libro de códigos | codeboek | livro de códigos | دليل الرموز |
| document | documento | document | documento | مستند |
| folder | carpeta | map | pasta | مجلد |
| logbook | bitácora | logboek | diário de bordo | السجل |
| memo | memo (m.) | memo (pl. memo's) | memo (m.) | مذكرة |
| note, notebook | nota, cuaderno | notitie, notitieboek | nota, caderno | ملاحظة، دفتر |
| panel / pane | panel | paneel | painel | لوحة |
| project | proyecto | project | projeto | مشروع |
| query | consulta | query (pl. query's) | consulta | استعلام |
| question (survey) | pregunta | vraag | pergunta | سؤال |
| quote | cita | citaat | citação | اقتباس |
| relationship map | mapa de relaciones | relatiekaart | mapa de relações | خريطة العلاقات |
| report | informe | rapport | relatório | تقرير |
| respondent | encuestado | respondent | respondente | مستجيب |
| ribbon | cinta | lint | faixa de opções | الشريط |
| save | guardar | bewaren | salvar | حفظ |
| selection | selección | selectie | seleção | تحديد |
| subcode | subcódigo | subcode | subcódigo | رمز فرعي |
| survey | encuesta | enquête | pesquisa | استبيان |
| tab | pestaña | tabblad | aba | علامة تبويب |
| tag | etiqueta | tag | etiqueta | وسم (ج. وسوم) |
| transcript | transcripción | transcript | transcrição | تفريغ نصي |
| Viewer (the document viewer) | visor | viewer | visualizador | العارض |

## Adding a language

1. Copy `en.json` to `<id>.json`, using the BCP 47 tag macOS uses
   (`fr`, `de`, `zh-Hans`), and translate it. Add its name to every
   catalogue as `language.name.<id>`, in that language's own words.
2. Add it to `CATALOGUES` in `src/renderer/i18n/index.ts` (an import and
   one entry; the Preferences picker and system-language matching follow).
3. Add it to `CATALOGUES` in `src-tauri/src/i18n.rs` and to
   `CFBundleLocalizations` in `src-tauri/Info.plist`.
4. Add its stop words to `src/renderer/components/Analysis/stop-words.ts`
   (the typecheck fails until it has a list).
5. Add its column to the tables above.

Plural rules, number and date formats and alphabetical order come from
CLDR (the browser's `Intl` in the renderer, ICU4X in the backend), so no
code is needed for them. `npm test` and `cargo test` fail until every step
is done, and list the plural forms the language needs (French, for
instance, adds `_many`).

## Questions for reviewers

- **Arabic:** word counts treat words with and without vowel marks
  ("كَتَبَ", "كتب"), and the alef variants (أ, إ, آ, ا), as different
  words. Should Word Frequencies, Word Combinations and text search treat
  them as the same word (normalise them), always or as an option?
