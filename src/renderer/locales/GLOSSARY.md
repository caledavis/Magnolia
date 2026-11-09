# Translation glossary

Magnolia's interface text lives in one catalogue per language in this
folder: `en.json` (the source), and `es` (Spanish), `nl` (Dutch), `pt-BR`
(Brazilian Portuguese), `pt-PT` (European Portuguese), `ar` (Arabic), `fr`
(French), `ru` (Russian), `zh-Hans` (Simplified Chinese), `it` (Italian),
`hi` (Hindi), `de` (German) and `fi` (Finnish). The renderer reads them through
i18next (`src/renderer/i18n`); the Rust backend reads the `native` section
for its menus, file dialogs, window titles and update messages
(`src-tauri/src/i18n.rs`).

Every key in `en.json` must exist in the other catalogues, with the same
`{{placeholders}}` (`test/renderer/i18n-catalogues.test.ts` checks this).
Plural strings use i18next's suffixes: `_one` and `_other`, plus `_many`
in Spanish and Portuguese (CLDR uses it for millions, "1 millón de
códigos"), and all six (`_zero`, `_one`, `_two`, `_few`, `_many`,
`_other`) in Arabic, whose zero, one and two forms usually name the
number in words ("رمزان", two codes). German and Finnish have `_one` and `_other`. Russian has `_one`, `_few` and `_many`
(1, 2–4 and 5–20 documents); French, Italian and both Portuguese have
`_one`, `_many` and `_other`; Hindi `_one` and `_other`; Chinese only
`_other`. The tests list whatever forms a language needs.

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

## Reviewing a language

`npm run i18n:review-export -- <lang|all>` makes a spreadsheet per language
in `translation-review/` for a native speaker: every string with where it
appears, the English, the current translation, and columns for their
correction and comments, plus this glossary's terms, the language's stop
words and its questions below. `npm run i18n:review-import -- <lang>
<file.xlsx>` applies the corrections whose placeholders match the English,
reports the rest, and lists comments and stop-word changes to make by
hand. Then run `npm test`.

## Changing the English

Interface text goes in `en.json` and is shown with `t()`; a test
(`test/renderer/i18n-hardcoded.test.ts`) finds English written straight
into a component. A symbol or unit that stays as written can be allowed
with an `i18n-ignore` comment.

After adding, changing or removing English, run `npm run i18n:sync`. It
records the English in `src/renderer/i18n/translation-status.json` and
marks, per language, the messages waiting for a translator: **new** ones
(shown in English until translated) and **changed** ones (the translation
was made for the old English). It removes messages English no longer has
from every catalogue. The tests fail until it has been run, and allow a
language to lack only the messages marked new.

Review spreadsheets put the waiting messages first, with a Status column
and a "Checked" column for a translation that still fits the new English;
importing clears what the reviewer translated or checked. A change that
doesn't affect the translations (a typo fix) can be cleared with
`npm run i18n:sync -- done all <key>…`.

## Conventions

| | Spanish | Dutch | Portuguese (Brazil) | Arabic | French | Russian | Chinese (Simplified) | Italian | Hindi | Portuguese (Portugal) | German | Finnish |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Address the user as | *tú* | *je* | *você* | Commands as verbal nouns ("حفظ"), so no gender; sentences in the masculine singular where unavoidable | *vous* | *вы* | 您 | *tu* | आप | third person, without *você* ("Pode…") | *Sie* | *sinä*, mostly implied by the verb |
| Capitalisation | Sentence case | Sentence case | Sentence case | — | Sentence case | Sentence case | — | Sentence case | — | Sentence case | Sentence case (nouns capitalised as in German) | Sentence case |
| Menu commands | Infinitive: "Guardar proyecto" | Imperative, as on macOS: "Bewaar project" | Infinitive: "Salvar projeto" | Verbal noun: "حفظ المشروع" | Infinitive: "Enregistrer le projet" | Infinitive: "Сохранить проект" | Verb: "保存项目" | Imperative, as on macOS: "Salva progetto" | Polite imperative: "परियोजना सहेजें" | Infinitive: "Guardar projeto" | Infinitive: "Projekt speichern" | Imperative: "Tallenna projekti" |
| Buttons and tooltips | Infinitive: "Importar" | Infinitive, as in Office: "Importeren" | Infinitive: "Importar" | Verbal noun: "استيراد" | Infinitive: "Importer" | Infinitive: "Импортировать" | Verb: "导入" | Imperative: "Importa" | Polite imperative: "आयात करें" | Infinitive: "Importar" | Infinitive: "Importieren" | Imperative: "Tuo" |
| Quotation marks | « » | " " | " " | “ ” (and « » around interface names) | « » | « » | “ ” | « » | “ ” | « » | „ “ | ” ” |
| The app's name | Magnolia | Magnolia | o Magnolia (masculine, like "o aplicativo") | Magnolia, in Latin letters | Magnolia | Magnolia | Magnolia | Magnolia | Magnolia | o Magnolia | Magnolia | Magnolia (Magnolian, Magnoliaa…) |
| Query operators | AND, OR, NOT, XOR stay in English, as query syntax; their explanations are translated | same | same | same | same | same | same | same | same | same | same | same |

## Terms

| English | Spanish | Dutch | Portuguese (Brazil) | Arabic | French | Russian | Chinese (Simplified) | Italian | Hindi | Portuguese (Portugal) | German | Finnish |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| analysis (a saved analysis) | análisis | analyse | análise | تحليل | analyse | анализ | 分析 | analisi | विश्लेषण | análise | Analyse | analyysi |
| box selection | selección de recuadro | kaderselectie | seleção de caixa | تحديد مربع | sélection rectangulaire | прямоугольное выделение | 框选 | selezione rettangolare | बॉक्स चयन | seleção de caixa | Rechteckauswahl | laatikkovalinta |
| code (noun) | código | code | código | رمز (ج. رموز) | code | код | 代码 | codice | कोड | código | Code | koodi |
| code (verb), coding | codificar, codificación | coderen, codering | codificar, codificação | رمّز، ترميز | coder, codage | кодировать, кодирование | 编码 | codificare, codifica | कोड करना, कोडिंग | codificar, codificação | codieren, Codierung | koodata, koodaus |
| coded segment | segmento codificado | gecodeerd segment | segmento codificado | مقطع مرمّز | segment codé | закодированный фрагмент | 已编码片段 | segmento codificato | कोड किया गया अंश | segmento codificado | codiertes Segment | koodattu segmentti |
| codebook | libro de códigos | codeboek | livro de códigos | دليل الرموز | livre de codes | книга кодов | 代码本 | libro dei codici | कोडबुक | livro de códigos | Codebuch | koodikirja |
| document | documento | document | documento | مستند | document | документ | 文档 | documento | दस्तावेज़ | documento | Dokument | dokumentti |
| folder | carpeta | map | pasta | مجلد | dossier | папка | 文件夹 | cartella | फ़ोल्डर | pasta | Ordner | kansio |
| logbook | bitácora | logboek | diário de bordo | السجل | journal | журнал | 日志 | diario | लॉगबुक | diário de bordo | Logbuch | lokikirja |
| memo | memo (m.) | memo (pl. memo's) | memo (m.) | مذكرة | mémo | заметка | 备忘录 | memo | मेमो | memo | Memo | muistio |
| note, notebook | nota, cuaderno | notitie, notitieboek | nota, caderno | ملاحظة، دفتر | note, carnet | запись, блокнот | 笔记, 笔记本 | nota, quaderno | नोट, नोटबुक | nota, caderno | Notiz, Notizbuch | muistiinpano, muistikirja |
| panel / pane | panel | paneel | painel | لوحة | volet | панель | 窗格 | riquadro | पैनल | painel | Bereich | paneeli |
| project | proyecto | project | projeto | مشروع | projet | проект | 项目 | progetto | परियोजना | projeto | Projekt | projekti |
| query | consulta | query (pl. query's) | consulta | استعلام | requête | запрос | 查询 | query | क्वेरी | consulta | Abfrage | haku |
| question (survey) | pregunta | vraag | pergunta | سؤال | question | вопрос | 问题 | domanda | प्रश्न | pergunta | Frage | kysymys |
| quote | cita | citaat | citação | اقتباس | citation | цитата | 引文 | citazione | उद्धरण | citação | Zitat | lainaus |
| relationship map | mapa de relaciones | relatiekaart | mapa de relações | خريطة العلاقات | carte des relations | карта связей | 关系地图 | mappa delle relazioni | संबंध नक्शा | mapa de relações | Beziehungskarte | suhdekartta |
| report | informe | rapport | relatório | تقرير | rapport | отчёт | 报告 | report | रिपोर्ट | relatório | Bericht | raportti |
| respondent | encuestado | respondent | respondente | مستجيب | répondant | респондент | 受访者 | rispondente | उत्तरदाता | respondente | befragte Person, Befragte | vastaaja |
| ribbon | cinta | lint | faixa de opções | الشريط | ruban | лента | 功能区 | barra multifunzione | रिबन | faixa de opções | Menüband | valintanauha |
| save | guardar | bewaren | salvar | حفظ | enregistrer | сохранить | 保存 | salvare | सहेजें | guardar | speichern | tallentaa |
| selection | selección | selectie | seleção | تحديد | sélection | выделение | 选段 | selezione | चयन | seleção | Auswahl | valinta |
| subcode | subcódigo | subcode | subcódigo | رمز فرعي | sous-code | подкод | 子代码 | sottocodice | उप-कोड | subcódigo | Subcode | alakoodi |
| survey | encuesta | enquête | pesquisa | استبيان | enquête | опрос | 调查 | sondaggio | सर्वेक्षण | inquérito | Umfrage | kysely |
| tab | pestaña | tabblad | aba | علامة تبويب | onglet | вкладка | 标签页 | pannello | टैब | separador | Tab | välilehti |
| tag | etiqueta | tag | etiqueta | وسم (ج. وسوم) | étiquette | метка | 标签 | etichetta | टैग | etiqueta | Tag | tunniste |
| transcript | transcripción | transcript | transcrição | تفريغ نصي | transcription | транскрипт | 转录稿 | trascrizione | प्रतिलेख | transcrição | Transkript | litteraatti |
| Viewer (the document viewer) | visor | viewer | visualizador | العارض | visionneuse | просмотр | 查看器 | visualizzatore | व्यूअर | visualizador | Viewer | katseluohjelma |

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

- **French and Italian:** an elided article stays on its word ("l'école"
  is counted apart from "école"; common forms such as "c'est" are stop
  words). Should word counts strip elided articles (l', d', qu'…)?
- **European Portuguese:** drafted by adapting the Brazilian catalogue
  (vocabulary such as *ficheiro*, *guardar*, *eliminar*, *inquérito*, the
  continuous "a carregar", possessives with an article). It needs a full
  review, not only a check of the terms above.
- **Chinese:** only Simplified Chinese exists; Traditional Chinese systems
  (Taiwan, Hong Kong) get Simplified. Is that acceptable, or should
  Traditional Chinese (`zh-Hant`) be added?
- **Hindi:** numbers are written with Western digits, as CLDR has it for
  Hindi. Would Devanagari digits (०१२) be wanted as a choice?
- **Russian:** some Analyse labels ("Совместная встречаемость кодов") are
  long enough that the ribbon scrolls in a narrow window. A shorter name
  would avoid it.
- **Finnish:** "kysely" is the usual word for both a query and a survey;
  the draft uses *haku* for a query (Hakutyökalu, Tallennetut haut) and
  *kysely* for a survey, to keep them apart. Is that clear, or is there a
  better pair?
- **German:** respondents are *Befragte* (plural) and *befragte Person*
  (singular), to avoid choosing a gender. Does that read naturally?
- **Arabic:** word counts treat words with and without vowel marks
  ("كَتَبَ", "كتب"), and the alef variants (أ, إ, آ, ا), as different
  words. Should Word Frequencies, Word Combinations and text search treat
  them as the same word (normalise them), always or as an option?
