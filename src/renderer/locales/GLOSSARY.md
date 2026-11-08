# Translation glossary

Magnolia's interface text lives in one catalogue per language in this
folder: `en.json` (the source), `es.json` (Spanish), `nl.json` (Dutch) and
`pt-BR.json` (Brazilian Portuguese). The renderer reads them through
i18next (`src/renderer/i18n`); the Rust backend reads the `native` section
for its menus, file dialogs, window titles and update messages
(`src-tauri/src/i18n.rs`).

Every key in `en.json` must exist in the other three, with the same
`{{placeholders}}` (`test/renderer/i18n-catalogues.test.ts` checks this).
Plural strings use i18next's suffixes: `_one` and `_other`, plus `_many`
in Spanish and Portuguese (CLDR uses it for millions, "1 millón de
códigos").

Numbers, percentages, dates and times are written by the code in each
language's own way (`formatNumber`, `formatPercent`, `formatDateTime` in
`src/renderer/i18n`): a number put into a message arrives as "1,234" or
"1.234", and a percentage arrives with its % sign. So a translation never
adds a % sign or separators of its own. CSV exports keep plain "12.5"
decimals, which spreadsheets read in any language.

The translations were drafted by Claude and need review by native
speakers before release. Keep to the terms below so the interface uses
one word for each idea; change a term here first, then everywhere.

## Conventions

| | Spanish | Dutch | Portuguese (Brazil) |
|---|---|---|---|
| Address the user as | *tú* | *je* | *você* |
| Capitalisation | Sentence case | Sentence case | Sentence case |
| Menu commands | Infinitive: "Guardar proyecto" | Imperative, as on macOS: "Bewaar project" | Infinitive: "Salvar projeto" |
| Buttons and tooltips | Infinitive: "Importar" | Infinitive, as in Office: "Importeren" | Infinitive: "Importar" |
| Quotation marks | « » | " " | " " |
| The app's name | Magnolia | Magnolia | o Magnolia (masculine, like "o aplicativo") |
| Query operators | AND, OR, NOT, XOR stay in English, as query syntax; their explanations are translated | same | same |

## Terms

| English | Spanish | Dutch | Portuguese (Brazil) |
|---|---|---|---|
| analysis (a saved analysis) | análisis | analyse | análise |
| box selection | selección de recuadro | kaderselectie | seleção de caixa |
| code (noun) | código | code | código |
| code (verb), coding | codificar, codificación | coderen, codering | codificar, codificação |
| coded segment | segmento codificado | gecodeerd segment | segmento codificado |
| codebook | libro de códigos | codeboek | livro de códigos |
| document | documento | document | documento |
| folder | carpeta | map | pasta |
| logbook | bitácora | logboek | diário de bordo |
| memo | memo (m.) | memo (pl. memo's) | memo (m.) |
| note, notebook | nota, cuaderno | notitie, notitieboek | nota, caderno |
| panel / pane | panel | paneel | painel |
| project | proyecto | project | projeto |
| query | consulta | query (pl. query's) | consulta |
| question (survey) | pregunta | vraag | pergunta |
| quote | cita | citaat | citação |
| relationship map | mapa de relaciones | relatiekaart | mapa de relações |
| report | informe | rapport | relatório |
| respondent | encuestado | respondent | respondente |
| ribbon | cinta | lint | faixa de opções |
| save | guardar | bewaren | salvar |
| selection | selección | selectie | seleção |
| subcode | subcódigo | subcode | subcódigo |
| survey | encuesta | enquête | pesquisa |
| tab | pestaña | tabblad | aba |
| tag | etiqueta | tag | etiqueta |
| transcript | transcripción | transcript | transcrição |
| Viewer (the document viewer) | visor | viewer | visualizador |
