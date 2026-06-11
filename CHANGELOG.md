# Changelog

All notable changes to Magnolia are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows [Semantic Versioning](https://semver.org/).

## [1.4.0]

### Added
- **Reports** — a new analysis tool for compiling your work into a single, shareable PDF. Drag saved queries, analyses, quotes, and memos onto the canvas, add your own headings (sections and subsections) and free-text notes, and reorder everything by dragging. Everything is regenerated from your current data at export time, so a report never carries stale numbers: analysis tables, saved-query results, and Relationship Maps all render fresh, and survey responses are cited by respondent and question. The exported PDF opens with a numbered, indented table of contents with page numbers. Each analysis can be shown as totals-only, binary, or visual, and a Word Frequencies item can add a bar chart and/or a word cloud beneath its table. Reports save with your project like any other analysis.

### Changed
- **Cleaner quotes in the Quotes panel.** Quote previews now read upright and without the surrounding quotation marks.

### Fixed
- **Delete works while editing rich text.** Pressing Delete or Backspace in a memo, a Relationship-Map note, or a report text block is no longer intercepted when an analysis tool or the Query Builder is open in another tab.

## [1.3.0]

### Added
- **Donut charts in the Survey Overview.** Single-select questions now show a donut chart of the answer distribution alongside the existing percentages, with the option list doubling as a colour-matched legend. The chart is included in the exported PDF too.
- **Contents page in the survey summary PDF.** The exported PDF now opens with a Contents section mirroring the Survey Overview's question table. Open-ended questions show a "Show answers" link that jumps to that question's responses later in the document, keeping the overview compact.
- **Binary view for analysis tables.** Codes in Documents, Results in Documents, and Code Co-Occurrences now have a "Binary" button next to "Visual" that shows each cell as 1 (present) or 0 (absent), with the row and column totals counting how many cells are present. CSV export reflects whichever view is active.
- **Group analysis tools by survey respondent.** Analysis tools can now break their results down by individual survey respondent, with a whole-survey subtotal, so you can compare coding across the people who answered a survey.
- **Scope analysis tools to specific survey questions.** When a survey is in scope, you can now limit an analysis tool to one or more questions, so the results reflect only the responses to those questions.
- **Portable Windows build.** A no-install version of Magnolia for Windows that runs without administrator rights — ideal for managed or work computers where you can't run an installer. Download it from the releases page (linked in the README). It doesn't update itself, so use "Check for Updates" to know when a new version is out.
- **Check for Updates in Preferences.** A new Updates section in Preferences shows your current version and lets you check for a newer one at any time, with the result shown inline — a fallback for when the background updater can't run (for example on a locked-down computer or the portable build).
- **Update-available nudge.** When a newer version has been released, a small badge appears on the Magnolia wordmark in the toolbar; clicking it opens the Updates section, where you can download the latest version. This works on every build, including ones that can't update themselves.
- **Support Magnolia.** Links to Magnolia's GitHub Sponsors page now appear in a new "Support Magnolia" section of Preferences, in the Help menu, and on the Welcome screen, for anyone who'd like to support its development.

### Changed
- **The Windows installer no longer needs an administrator password.** It now installs Magnolia for the current user only, so it runs on computers where you don't have admin rights.
- **Coding a survey response is locked to one answer at a time.** In the Respondent and Question views, a click-drag selection now stays within the answer it began in, so a drag can no longer spill across several respondents' (or questions') answers and code them together.

### Fixed
- **Coding an open response no longer also codes the next one.** In Respondent and Question mode, selecting a response whose selection ran through the invisible line break at its end would also apply the code to the following response. The selection now stops at the response you actually selected.

## [1.2.0]

### Added
- **Studio panel toggle** — a new toolbar button to show or hide the workspace panels (Documents, Codes, Queries, Memos, Quotes, Analyses). On Windows and Linux, which have no menu bar, this is now the way to reopen a panel after you close it; it works on macOS too.

### Changed
- **Cleaner saved-query names.** Auto-suggested names now read like "Choice to study law (incl. subcodes)" and list the tags and documents you actually chose, instead of spelling out every matching subcode and every resolved document.
- **Live document filters.** Re-running a saved query now re-applies its document filter against your current data, so a query scoped to (say) "Female ∩ Domestic" picks up documents you tag that way later — matching how code filters already behave, and what the in-app live re-run already implied.

### Fixed
- **Saved queries reopen as you built them.** Reopening a saved query now restores the exact Document Selector and Query Builder you authored, instead of rebuilding a larger, altered version from the query's resolved output. A code with "And subcodes" stays a single ticked node rather than exploding into one node per subcode, and a document filter keeps its operators instead of collapsing to a union of every matched document.
- **Coding lands on the text you selected.** Applying a code to a selection no longer jumps to a different passage when the cursor passes over a code, memo, or quote label on its way to the codebook.
- **Stronger protection against data loss when saving.** Project files are now written atomically, so an interrupted save — a crash, or quitting mid-save — can no longer truncate or corrupt your project. Magnolia also refuses to overwrite a project with empty content, and simply opening a project no longer triggers an unnecessary full rewrite.

## [1.1.0]

### Added
- **Linux support** — Magnolia is now available for Linux as an AppImage and a Debian/Ubuntu `.deb` package, alongside macOS and Windows.
- **In-app update prompt** — when a new version is available, Magnolia now shows a dialog with the release notes and lets you Install Now, Remind Me Later, or Skip This Version.

### Fixed
- macOS updates now also install when you quit the app, not only when you choose "Restart now".

## [1.0.7]

### Fixed
- macOS auto-update now reliably installs and relaunches. Earlier versions downloaded the update but never applied it (a Squirrel.Mac issue on modern macOS). Users on 1.0.0–1.0.6 need to update manually once; updates are automatic from 1.0.7 onward.

## [1.0.1]

### Added
- Windows installer download.
- Minimise / maximise / close window controls in the toolbar on Windows and Linux, which have no native title bar.

## [1.0.0]

First public release of Magnolia.
