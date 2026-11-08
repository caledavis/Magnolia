# Translation glossary

Magnolia's interface text lives in one catalogue per language in this
folder: `en.json` (the source), and `es` (Spanish), `nl` (Dutch), `pt-BR`
(Brazilian Portuguese), `pt-PT` (European Portuguese), `ar` (Arabic), `fr`
(French), `ru` (Russian), `zh-Hans` (Simplified Chinese), `it` (Italian)
and `hi` (Hindi). The renderer reads them through
i18next (`src/renderer/i18n`); the Rust backend reads the `native` section
for its menus, file dialogs, window titles and update messages
(`src-tauri/src/i18n.rs`).

Every key in `en.json` must exist in the other catalogues, with the same
`{{placeholders}}` (`test/renderer/i18n-catalogues.test.ts` checks this).
Plural strings use i18next's suffixes: `_one` and `_other`, plus `_many`
in Spanish and Portuguese (CLDR uses it for millions, "1 millón de
códigos"), and all six (`_zero`, `_one`, `_two`, `_few`, `_many`,
`_other`) in Arabic, whose zero, one and two forms usually name the
number in words ("رمزان", two codes). Russian has `_one`, `_few` and `_many`
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

## Conventions

| | Spanish | Dutch | Portuguese (Brazil) | Arabic | French | Russian | Chinese (Simplified) | Italian | Hindi | Portuguese (Portugal) |
|---|---|---|---|---|---|---|---|---|---|---|
| Address the user as | *tú* | *je* | *você* | Commands as verbal nouns ("حفظ"), so no gender; sentences in the masculine singular where unavoidable | *vous* | *вы* | 您 | *tu* | आप | third person, without *você* ("Pode…") |
| Capitalisation | Sentence case | Sentence case | Sentence case | — | Sentence case | Sentence case | — | Sentence case | — | Sentence case |
| Menu commands | Infinitive: "Guardar proyecto" | Imperative, as on macOS: "Bewaar project" | Infinitive: "Salvar projeto" | Verbal noun: "حفظ المشروع" | Infinitive: "Enregistrer le projet" | Infinitive: "Сохранить проект" | Verb: "保存项目" | Imperative, as on macOS: "Salva progetto" | Polite imperative: "परियोजना सहेजें" | Infinitive: "Guardar projeto" |
| Buttons and tooltips | Infinitive: "Importar" | Infinitive, as in Office: "Importeren" | Infinitive: "Importar" | Verbal noun: "استيراد" | Infinitive: "Importer" | Infinitive: "Импортировать" | Verb: "导入" | Imperative: "Importa" | Polite imperative: "आयात करें" | Infinitive: "Importar" |
| Quotation marks | « » | " " | " " | “ ” (and « » around interface names) | « » | « » | “ ” | « » | “ ” | « » |
| The app's name | Magnolia | Magnolia | o Magnolia (masculine, like "o aplicativo") | Magnolia, in Latin letters | Magnolia | Magnolia | Magnolia | Magnolia | Magnolia | o Magnolia |
| Query operators | AND, OR, NOT, XOR stay in English, as query syntax; their explanations are translated | same | same | same | same | same | same | same | same | same |

## Terms

| English | Spanish | Dutch | Portuguese (Brazil) | Arabic | French | Russian | Chinese (Simplified) | Italian | Hindi | Portuguese (Portugal) |
|---|---|---|---|---|---|---|---|---|---|---|
| analysis (a saved analysis) | análisis | analyse | análise | تحليل | analyse | анализ | 分析 | analisi | विश्लेषण | análise |
| box selection | selección de recuadro | kaderselectie | seleção de caixa | تحديد مربع | sélection rectangulaire | прямоугольное выделение | 框选 | selezione rettangolare | बॉक्स चयन | seleção de caixa |
| code (noun) | código | code | código | رمز (ج. رموز) | code | код | 代码 | codice | कोड | código |
| code (verb), coding | codificar, codificación | coderen, codering | codificar, codificação | رمّز، ترميز | coder, codage | кодировать, кодирование | 编码 | codificare, codifica | कोड करना, कोडिंग | codificar, codificação |
| coded segment | segmento codificado | gecodeerd segment | segmento codificado | مقطع مرمّز | segment codé | закодированный фрагмент | 已编码片段 | segmento codificato | कोड किया गया अंश | segmento codificado |
| codebook | libro de códigos | codeboek | livro de códigos | دليل الرموز | livre de codes | книга кодов | 代码本 | libro dei codici | कोडबुक | livro de códigos |
| document | documento | document | documento | مستند | document | документ | 文档 | documento | दस्तावेज़ | documento |
| folder | carpeta | map | pasta | مجلد | dossier | папка | 文件夹 | cartella | फ़ोल्डर | pasta |
| logbook | bitácora | logboek | diário de bordo | السجل | journal | журнал | 日志 | diario | लॉगबुक | diário de bordo |
| memo | memo (m.) | memo (pl. memo's) | memo (m.) | مذكرة | mémo | заметка | 备忘录 | memo | मेमो | memo |
| note, notebook | nota, cuaderno | notitie, notitieboek | nota, caderno | ملاحظة، دفتر | note, carnet | запись, блокнот | 笔记, 笔记本 | nota, quaderno | नोट, नोटबुक | nota, caderno |
| panel / pane | panel | paneel | painel | لوحة | volet | панель | 窗格 | riquadro | पैनल | painel |
| project | proyecto | project | projeto | مشروع | projet | проект | 项目 | progetto | परियोजना | projeto |
| query | consulta | query (pl. query's) | consulta | استعلام | requête | запрос | 查询 | query | क्वेरी | consulta |
| question (survey) | pregunta | vraag | pergunta | سؤال | question | вопрос | 问题 | domanda | प्रश्न | pergunta |
| quote | cita | citaat | citação | اقتباس | citation | цитата | 引文 | citazione | उद्धरण | citação |
| relationship map | mapa de relaciones | relatiekaart | mapa de relações | خريطة العلاقات | carte des relations | карта связей | 关系地图 | mappa delle relazioni | संबंध नक्शा | mapa de relações |
| report | informe | rapport | relatório | تقرير | rapport | отчёт | 报告 | report | रिपोर्ट | relatório |
| respondent | encuestado | respondent | respondente | مستجيب | répondant | респондент | 受访者 | rispondente | उत्तरदाता | respondente |
| ribbon | cinta | lint | faixa de opções | الشريط | ruban | лента | 功能区 | barra multifunzione | रिबन | faixa de opções |
| save | guardar | bewaren | salvar | حفظ | enregistrer | сохранить | 保存 | salvare | सहेजें | guardar |
| selection | selección | selectie | seleção | تحديد | sélection | выделение | 选段 | selezione | चयन | seleção |
| subcode | subcódigo | subcode | subcódigo | رمز فرعي | sous-code | подкод | 子代码 | sottocodice | उप-कोड | subcódigo |
| survey | encuesta | enquête | pesquisa | استبيان | enquête | опрос | 调查 | sondaggio | सर्वेक्षण | inquérito |
| tab | pestaña | tabblad | aba | علامة تبويب | onglet | вкладка | 标签页 | pannello | टैब | separador |
| tag | etiqueta | tag | etiqueta | وسم (ج. وسوم) | étiquette | метка | 标签 | etichetta | टैग | etiqueta |
| transcript | transcripción | transcript | transcrição | تفريغ نصي | transcription | транскрипт | 转录稿 | trascrizione | प्रतिलेख | transcrição |
| Viewer (the document viewer) | visor | viewer | visualizador | العارض | visionneuse | просмотр | 查看器 | visualizzatore | व्यूअर | visualizador |

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
- **Arabic:** word counts treat words with and without vowel marks
  ("كَتَبَ", "كتب"), and the alef variants (أ, إ, آ, ا), as different
  words. Should Word Frequencies, Word Combinations and text search treat
  them as the same word (normalise them), always or as an option?
