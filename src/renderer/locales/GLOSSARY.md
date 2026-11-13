# Translation glossary

Magnolia's interface text lives in one catalogue per language in this
folder: `en.json` (the source), and `es` (Spanish), `nl` (Dutch), `pt-BR`
(Brazilian Portuguese), `pt-PT` (European Portuguese), `ar` (Arabic), `fr`
(French), `ru` (Russian), `zh-Hans` (Simplified Chinese), `it` (Italian),
`hi` (Hindi), `de` (German), `fi` (Finnish), `sv` (Swedish), `nb`
(Norwegian Bokmål; Norwegian and Nynorsk systems get it too), `da`
(Danish), `tr` (Turkish), `ca` (Catalan) and `cs` (Czech). The renderer reads them through
i18next (`src/renderer/i18n`); the Rust backend reads the `native` section
for its menus, file dialogs, window titles and update messages
(`src-tauri/src/i18n.rs`).

Every key in `en.json` must exist in the other catalogues, with the same
`{{placeholders}}` (`test/renderer/i18n-catalogues.test.ts` checks this).
Plural strings use i18next's suffixes: `_one` and `_other`, plus `_many`
in Spanish and Portuguese (CLDR uses it for millions, "1 millón de
códigos"), and all six (`_zero`, `_one`, `_two`, `_few`, `_many`,
`_other`) in Arabic, whose zero, one and two forms usually name the
number in words ("رمزان", two codes). German, Finnish, Swedish, Norwegian, Danish and Turkish have `_one` and
`_other`. Czech has `_one`, `_few` (2–4) and `_other` (5+), plus `_many`,
which CLDR uses only for fractions ("1,5 kódu"); the drafts copy `_other`
into it, since Magnolia's counts are whole numbers. Catalan has `_one`,
`_many` and `_other`, like French. Russian has `_one`, `_few` and `_many`
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

| | Spanish | Dutch | Portuguese (Brazil) | Arabic | French | Russian | Chinese (Simplified) | Italian | Hindi | Portuguese (Portugal) | German | Finnish | Swedish | Norwegian (Bokmål) | Danish | Turkish | Catalan | Czech | Ukrainian | Lithuanian | Hebrew | Greek | Japanese |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Address the user as | *tú* | *je* | *você* | Commands as verbal nouns ("حفظ"), so no gender; sentences in the masculine singular where unavoidable | *vous* | *вы* | 您 | *tu* | आप | third person, without *você* ("Pode…") | *Sie* | *sinä*, mostly implied by the verb | *du* | *du* | *du* | *siz*, mostly implied by the verb | *vós* in messages ("Voleu…") | *vy* ("Chcete…") | *ви* ("Відкрийте…") | *jūs* ("Atverkite…") | Impersonal "יש ל…" and verbal nouns, so no gender; "{{name}} עובד/ת" where a verb needs one | *εσείς* ("Ανοίξτε…") | Polite です/ます; no pronoun ("ください") |
| Capitalisation | Sentence case | Sentence case | Sentence case | — | Sentence case | Sentence case | — | Sentence case | — | Sentence case | Sentence case (nouns capitalised as in German) | Sentence case | Sentence case | Sentence case | Sentence case | Sentence case | Sentence case | Sentence case | Sentence case | Sentence case | — | Sentence case | — |
| Menu commands | Infinitive: "Guardar proyecto" | Imperative, as on macOS: "Bewaar project" | Infinitive: "Salvar projeto" | Verbal noun: "حفظ المشروع" | Infinitive: "Enregistrer le projet" | Infinitive: "Сохранить проект" | Verb: "保存项目" | Imperative, as on macOS: "Salva progetto" | Polite imperative: "परियोजना सहेजें" | Infinitive: "Guardar projeto" | Infinitive: "Projekt speichern" | Imperative: "Tallenna projekti" | Imperative, as on macOS: "Spara projekt" | Imperative: "Lagre prosjekt" | Imperative: "Gem projekt" | Imperative: "Projeyi kaydet" | Imperative, as Softcatalà: "Desa el projecte" | Infinitive: "Uložit projekt" | Infinitive: "Зберегти проєкт" | Infinitive: "Įrašyti projektą" | Verbal noun: "שמירת הפרויקט" | Noun: "Αποθήκευση έργου" | Noun or verb phrase, as on macOS: "プロジェクトを保存" |
| Buttons and tooltips | Infinitive: "Importar" | Infinitive, as in Office: "Importeren" | Infinitive: "Importar" | Verbal noun: "استيراد" | Infinitive: "Importer" | Infinitive: "Импортировать" | Verb: "导入" | Imperative: "Importa" | Polite imperative: "आयात करें" | Infinitive: "Importar" | Infinitive: "Importieren" | Imperative: "Tuo" | Imperative: "Importera" | Imperative: "Importer" | Imperative: "Importér" | Imperative: "İçe aktar" | Imperative: "Importa" | Infinitive: "Importovat" | Infinitive: "Імпортувати" (ribbon labels as nouns: "Імпорт") | Infinitive: "Importuoti" | Verbal noun: "ייבוא" | Noun: "Εισαγωγή" | Noun: "保存", "読み込み" |
| Quotation marks | « » | " " | " " | “ ” (and « » around interface names) | « » | « » | “ ” | « » | “ ” | « » | „ “ | ” ” | ” ” | « » | » « | “ ” | « » | „ “ | « » | „ “ | " " | « » | 「 」 |
| The app's name | Magnolia | Magnolia | o Magnolia (masculine, like "o aplicativo") | Magnolia, in Latin letters | Magnolia | Magnolia | Magnolia | Magnolia | Magnolia | o Magnolia | Magnolia | Magnolia (Magnolian, Magnoliaa…) | Magnolia (Magnolias) | Magnolia (Magnolias) | Magnolia (Magnolias) | Magnolia, suffixes after ’ (Magnolia’yı, Magnolia’dan) | el Magnolia | "aplikace Magnolia" where a case ending is needed; Magnolia otherwise | Magnolia (feminine: "Magnolia безкоштовна") | Magnolia (feminine, not declined) | Magnolia, in Latin letters (feminine: "Magnolia יכולה") | το Magnolia (neuter) | Magnolia, in Latin letters |
| Query operators | AND, OR, NOT, XOR stay in English, as query syntax; their explanations are translated | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same | same |

**Spanish past events:** the one Spanish catalogue serves Spain and Latin
America, so a finished event takes the simple past, which is natural
everywhere: "No se pudo abrir el proyecto", "un fallo vació los
documentos". Not the present perfect ("No se ha podido…", "ha vaciado"),
which reads as from Spain in Latin America. A reviewer noted the
difference in November 2026 (correct, but more Latin American in feel)
and the simple past was kept.

## Terms

| English | Spanish | Dutch | Portuguese (Brazil) | Arabic | French | Russian | Chinese (Simplified) | Italian | Hindi | Portuguese (Portugal) | German | Finnish | Swedish | Norwegian (Bokmål) | Danish | Turkish | Catalan | Czech | Ukrainian | Lithuanian | Hebrew | Greek | Japanese |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| analysis (a saved analysis) | análisis | analyse | análise | تحليل | analyse | анализ | 分析 | analisi | विश्लेषण | análise | Analyse | analyysi | analys | analyse | analyse | analiz | anàlisi (f.) | analýza | аналіз | analizė | ניתוח | ανάλυση | 分析 |
| box selection | selección de recuadro | kaderselectie | seleção de caixa | تحديد مربع | sélection rectangulaire | прямоугольное выделение | 框选 | selezione rettangolare | बॉक्स चयन | seleção de caixa | Rechteckauswahl | laatikkovalinta | rutmarkering | rektangelmarkering | rektangelmarkering | kutu seçimi | selecció rectangular | obdélníkový výběr | прямокутне виділення | stačiakampis žymėjimas | בחירת מלבן | ορθογώνια επιλογή | 矩形選択 |
| code (noun) | código | code | código | رمز (ج. رموز) | code | код | 代码 | codice | कोड | código | Code | koodi | kod | kode | kode | kod | codi | kód | код | kodas | קוד | κωδικός | コード |
| code (verb), coding | codificar, codificación | coderen, codering | codificar, codificação | رمّز، ترميز | coder, codage | кодировать, кодирование | 编码 | codificare, codifica | कोड करना, कोडिंग | codificar, codificação | codieren, Codierung | koodata, koodaus | koda, kodning | kode, koding | kode, kodning | kodlamak, kodlama | codificar, codificació | kódovat, kódování | кодувати, кодування | koduoti, kodavimas | לקודד, קידוד | κωδικοποιώ, κωδικοποίηση | コーディングする, コーディング |
| coded segment | segmento codificado | gecodeerd segment | segmento codificado | مقطع مرمّز | segment codé | закодированный фрагмент | 已编码片段 | segmento codificato | कोड किया गया अंश | segmento codificado | codiertes Segment | koodattu segmentti | kodat segment | kodet segment | kodet segment | kodlanmış bölüm | segment codificat | kódovaný úsek | закодований фрагмент | užkoduotas fragmentas | קטע מקודד | κωδικοποιημένο τμήμα | コード化セグメント |
| codebook | libro de códigos | codeboek | livro de códigos | دليل الرموز | livre de codes | книга кодов | 代码本 | libro dei codici | कोडबुक | livro de códigos | Codebuch | koodikirja | kodbok | kodebok | kodebog | kod kitabı | llibre de codis | kódovací kniha | книга кодів | kodų knyga | ספר קודים | βιβλίο κωδικών | コードブック |
| document | documento | document | documento | مستند | document | документ | 文档 | documento | दस्तावेज़ | documento | Dokument | dokumentti | dokument | dokument | dokument | belge | document | dokument | документ | dokumentas | מסמך | έγγραφο | ドキュメント |
| folder | carpeta | map | pasta | مجلد | dossier | папка | 文件夹 | cartella | फ़ोल्डर | pasta | Ordner | kansio | mapp | mappe | mappe | klasör | carpeta | složka | папка | aplankas | תיקייה | φάκελος | フォルダ |
| logbook | bitácora | logboek | diário de bordo | السجل | journal | журнал | 日志 | diario | लॉगबुक | diário de bordo | Logbuch | lokikirja | loggbok | loggbok | logbog | günlük | diari | deník | журнал (entry: запис журналу) | žurnalas (entry: įrašas) | יומן (entry: רישום) | ημερολόγιο (entry: καταχώριση) | ログブック (entry: エントリ) |
| memo | memo (m.) | memo (pl. memo's) | memo (m.) | مذكرة | mémo | заметка | 备忘录 | memo | मेमो | memo | Memo | muistio | memo (pl. memon) | memo (pl. memoer) | memo (pl. memoer) | memo | memo (m.) | poznámka | нотатка | pastaba | תזכיר | υπόμνημα | メモ |
| note, notebook | nota, cuaderno | notitie, notitieboek | nota, caderno | ملاحظة، دفتر | note, carnet | запись, блокнот | 笔记, 笔记本 | nota, quaderno | नोट, नोटबुक | nota, caderno | Notiz, Notizbuch | muistiinpano, muistikirja | anteckning, anteckningsbok | notat, notatbok | note, notesbog | not, defter | nota, quadern | záznam, zápisník | запис, блокнот | užrašas, užrašinė | רשומה, מחברת | σημείωση, σημειωματάριο | ノート, ノートブック |
| panel / pane | panel | paneel | painel | لوحة | volet | панель | 窗格 | riquadro | पैनल | painel | Bereich | paneeli | panel | panel | panel | bölme | plafó | panel | панель | polangis | חלונית | πλαίσιο | パネル |
| project | proyecto | project | projeto | مشروع | projet | проект | 项目 | progetto | परियोजना | projeto | Projekt | projekti | projekt | prosjekt | projekt | proje | projecte | projekt | проєкт | projektas | פרויקט | έργο | プロジェクト |
| query | consulta | query (pl. query's) | consulta | استعلام | requête | запрос | 查询 | query | क्वेरी | consulta | Abfrage | haku | sökfråga | spørring | forespørgsel | sorgu | consulta | dotaz | запит | užklausa | שאילתה | ερώτημα | クエリ |
| question (survey) | pregunta | vraag | pergunta | سؤال | question | вопрос | 问题 | domanda | प्रश्न | pergunta | Frage | kysymys | fråga | spørsmål | spørgsmål | soru | pregunta | otázka | питання | klausimas | שאלה | ερώτηση | 質問 |
| quote | cita | citaat | citação | اقتباس | citation | цитата | 引文 | citazione | उद्धरण | citação | Zitat | lainaus | citat | sitat | citat | alıntı | cita | citace | цитата | citata | ציטוט | απόσπασμα | 引用 |
| relationship map | mapa de relaciones | relatiekaart | mapa de relações | خريطة العلاقات | carte des relations | карта связей | 关系地图 | mappa delle relazioni | संबंध नक्शा | mapa de relações | Beziehungskarte | suhdekartta | relationskarta | relasjonskart | relationskort | ilişki haritası | mapa de relacions | mapa vztahů | карта зв’язків | ryšių žemėlapis | מפת קשרים | χάρτης σχέσεων | 関係マップ |
| report | informe | rapport | relatório | تقرير | rapport | отчёт | 报告 | report | रिपोर्ट | relatório | Bericht | raportti | rapport | rapport | rapport | rapor | informe | zpráva | звіт | ataskaita | דוח | αναφορά | レポート |
| respondent | encuestado | respondent | respondente | مستجيب | répondant | респондент | 受访者 | rispondente | उत्तरदाता | respondente | befragte Person, Befragte | vastaaja | respondent | respondent | respondent | katılımcı | enquestat | respondent | респондент | respondentas | משיב | ερωτώμενος | 回答者 |
| ribbon | cinta | lint | faixa de opções | الشريط | ruban | лента | 功能区 | barra multifunzione | रिबन | faixa de opções | Menüband | valintanauha | menyfliksområde | bånd | bånd | şerit | cinta | pás karet | стрічка | juostelė | רצועת כלים | κορδέλα | リボン |
| save | guardar | bewaren | salvar | حفظ | enregistrer | сохранить | 保存 | salvare | सहेजें | guardar | speichern | tallentaa | spara | lagre | gem | kaydet | desar | uložit | зберегти | įrašyti | שמירה | αποθήκευση | 保存 |
| selection | selección | selectie | seleção | تحديد | sélection | выделение | 选段 | selezione | चयन | seleção | Auswahl | valinta | markering | markering | markering | seçim | selecció | výběr | виділення, фрагмент | žymėjimas, fragmentas | בחירה | επιλογή | 選択範囲 |
| subcode | subcódigo | subcode | subcódigo | رمز فرعي | sous-code | подкод | 子代码 | sottocodice | उप-कोड | subcódigo | Subcode | alakoodi | underkod | underkode | underkode | alt kod | subcodi | podkód | підкод | subkodas | קוד משנה | υποκωδικός | サブコード |
| survey | encuesta | enquête | pesquisa | استبيان | enquête | опрос | 调查 | sondaggio | सर्वेक्षण | inquérito | Umfrage | kysely | enkät | undersøkelse | undersøgelse | anket | enquesta | průzkum | опитування | apklausa | סקר | έρευνα | アンケート |
| tab | pestaña | tabblad | aba | علامة تبويب | onglet | вкладка | 标签页 | pannello | टैब | separador | Tab | välilehti | flik | fane | fane | sekme | pestanya | karta | вкладка | kortelė | כרטיסייה | καρτέλα | タブ |
| tag | etiqueta | tag | etiqueta | وسم (ج. وسوم) | étiquette | метка | 标签 | etichetta | टैग | etiqueta | Tag | tunniste | tagg | etikett | tag (pl. tags) | etiket | etiqueta | štítek | мітка | žyma | תגית | ετικέτα | タグ |
| transcript | transcripción | transcript | transcrição | تفريغ نصي | transcription | транскрипт | 转录稿 | trascrizione | प्रतिलेख | transcrição | Transkript | litteraatti | transkription | transkripsjon | transskription | transkript | transcripció | přepis | транскрипт | transkripcija | תמלול | απομαγνητοφώνηση | 文字起こし |
| Viewer (the document viewer) | visor | viewer | visualizador | العارض | visionneuse | просмотр | 查看器 | visualizzatore | व्यूअर | visualizador | Viewer | katseluohjelma | visare | fremviser | fremviser | görüntüleyici | visualitzador | prohlížeč | перегляд | peržiūra | מציג | προβολή | ビューア |

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
6. Check the layout in the app: `npm run layout-check -- --lang <id>`
   (every ribbon tab, view, tool, menu and dialog; add `ribbon-rtl` and
   `rtl-ui` for a right-to-left language). It reports labels that don't
   fit and text that overflows, and saves captures in `layout-report/`
   to look over. See `scripts/layout-check/run.mjs` for the other checks.

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
- **Swedish:** a query is *sökfråga*, to keep it apart from a survey
  *fråga* (question). Does it read well in the Analyse tab?
- **Norwegian:** the catalogue is Bokmål, and Nynorsk systems get it too.
  Is that acceptable, or is a Nynorsk catalogue (`nn`) wanted?
- **Danish:** *tag* (pl. *tags*) is kept for a tag, as in much Danish
  software. Would *mærke* be better?
- **Turkish:** names put into messages ("{{name}} bu dosya üzerinde
  çalışıyor") are never given suffixes, since their vowel harmony isn't
  known; some sentences are built around that ("şu kişinin sürümü:
  {{name}}"). Do any read too stiffly?
- **Catalan:** commands are imperatives ("Desa", "Importa") and messages
  address the user as *vós*, as Softcatalà does. Is that the right mix?
- **Czech:** memos are *poznámky* and notebook notes *záznamy*, so the two
  don't clash. The app's name is avoided where it would need a case ending
  ("aplikace Magnolia"). Do those read naturally?
- **Arabic:** word counts treat words with and without vowel marks
  ("كَتَبَ", "كتب"), and the alef variants (أ, إ, آ, ا), as different
  words. Should Word Frequencies, Word Combinations and text search treat
  them as the same word (normalise them), always or as an option?
- **All languages (Import from Zotero):** the message shown when Zotero
  won't share its library names Zotero's own settings (Settings, Advanced,
  and the "Allow other applications on this computer to communicate with
  Zotero" checkbox). These were translated without Zotero to hand, so
  please check them against Zotero's wording in your language. Hindi keeps
  the English names, as Zotero has no Hindi interface. The creator roles
  (Author, Editor, Interviewee…) should also match Zotero's.
- **Ukrainian:** memos are *нотатки*, notebook notes *записи* and logbook
  entries *записи журналу*, so the three don't clash. Is *запис* right for
  a note, and does *запис журналу* read well? Ribbon labels are nouns
  ("Імпорт", "Злиття") but other buttons infinitives ("Імпортувати").
- **Lithuanian:** commands are infinitives ("Įrašyti", "Importuoti"), as
  in Microsoft's Lithuanian. Memos are *pastabos*, notes *užrašai* in a
  *užrašinė*. The year box in date ranges is labelled MMMM (*metai*) next
  to MM for the month: is that clear, or should it be another letter?
- **Hebrew:** instructions use the impersonal "יש ל…" and commands verbal
  nouns, so the user is never addressed as one gender; where a sentence
  needs a verb for another person it says "עובד/ת". Does that read well?
  Magnolia is treated as feminine ("Magnolia יכולה"). The Zotero message
  keeps Zotero's settings in English, but Zotero has a Hebrew interface:
  please give its Hebrew names. Lists the English calls "on the left" say
  "from the list" instead, as the layout is mirrored.
- **Greek:** commands are nouns ("Αποθήκευση"), as in Microsoft's Greek.
  A quote is an *απόσπασμα*, so coded passages are *τμήματα* to keep them
  apart. Other people are "ο/η {{name}}" where an article is needed.
- **Japanese:** commands follow macOS (verb phrases in menus, short
  nouns on buttons), messages are polite です/ます, and people are "{{name}}
  さん". Importing is 読み込み and exporting 書き出し, as on macOS; would
  インポート/エクスポート be better for researchers? Memos are メモ and
  notebook notes ノート. The Zotero message uses Zotero's Japanese setting
  names from memory: please check them against Zotero.
