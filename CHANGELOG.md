# Changelog

All notable changes to Magnolia are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows [Semantic Versioning](https://semver.org/).

## [1.8.0]

### Added
- **Multi-user support.** One of the most requested features is finally here! Now, different people can work on a project. This does not allow simultaneous editing (that would require infrastructure beyond the scope of this project!) but it does allow you to compare your work on a project with others, review the changes, and merge projects together. Magnolia does this by 'locking' the file when you are editing it to indicate you are in control of it. If you walk away from your desk or your computer crashes, other people can take control from you to continue working from where you left off. You are also warned if you lose control through a little indicator in the Toolbar.
- **Merge tool.** You will see a new button in the toolbar: that's the Merge tool. It allows you to see how different versions of a project compare (perhaps your colleague worked on one copy while you were working on another copy), review the differences, and selectively merge them together.
- **Icon-only toolbar.** It saves space and looks better. If you want to switch it back to icons and text, do that through Preferences > Appearance.

### Fixed
- **More of a code's name is visible in the Viewer.** In case your codes have long names, you can see more of them now. 
- **Toolbar scrolling indicators.** If your screen is too small to show the whole toolbar, there are now indicators to show you that it is scrollable.
- **The EUPL and licences notices are moved.** To under the Help button.
- **Various other small things.**

## [1.7.1]

### Added
- **Import dialogs remember the last folder used.** These now open to the folder you last imported a file from for that project, instead of resetting every time.

### Fixed
- **Toolbar buttons no longer disappear on narrow or tiled windows.** The project name and window controls now stay pinned and reachable at any window size; the toolbar buttons in between scroll horizontally instead of being pushed off-screen and clipped.

## [1.7.0]

### Added
- **Interface Scale preference.** A new dropdown in Preferences > Appearance lets you scale Magnolia's fonts and icons to 100%, 125%, 150%, or 200%.
- **Search and filter every sidebar panel.** A magnifying-glass toggle now appears in each panel's header. Clicking this opens a small text box that allows you to filter the content of the panel. Close it by hitting the X or ESC.
- **Apply Code hint in context menus.** Right-click contextual menus in the Document Viewer now show a short instructional line explaining that dragging a code from the Code Browser onto a selection applies it.
- **Linux .rpm package.** Magnolia is now available as a native `.rpm`, for Fedora, RHEL, and openSUSE, alongside the existing AppImage and `.deb`. This also works around AppImages failing to launch on distros — like recent Fedora releases — that no longer ship `libfuse2` by default.

### Changed
- **OS-appropriate modifier keys.** Shortcut hints and hotkey labels now show Ctrl-based keys on Windows and Linux instead of macOS's ⌘/⌥ symbols everywhere.

### Fixed
- **Relationship Map node boxes no longer grow indefinitely on some displays.** On displays with fractional scaling (e.g. Windows at 125%/150%), a node's box could slowly stretch taller the longer the map stayed open.
- **Blank transcript text when importing NVivo QDPX files.** NVivo exports its sources folder with a capital "S", which Magnolia's importer didn't expect, so transcripts (and other imported content) came in empty even though the data was present in the file.
- **PDF scroll position no longer resets after visiting a tool tab.** Switching to Preferences, an Analysis tool, or the Query Builder and back to a PDF used to jump you back to page 1.

## [1.6.2]

### Fixed
- **Codes stay put when you edit transcript text.** Editing a line of a transcript in place no longer shifts the codes, quotes, and selection memos anchored further down — every anchor now follows the edit instead of drifting onto the wrong words, and a code's end no longer slips. Video timeline codings keep their timing, since editing a line's words doesn't change when it was spoken.
- **Audio and video imported from MAXQDA open in the right viewer.** MAXQDA names its sources without file extensions and stores audio inside a video source, so Magnolia used to show every imported media file with a generic document icon and open an `.m4a` recording in a black video player. Imported media is now classified by its real type — audio files open in the audio viewer and play correctly.

## [1.6.1]

### Added
- **Import WebVTT and SRT transcripts.** The transcript Import button now reads `.vtt` and `.srt` subtitle files directly — keeping millisecond-accurate timings and stripping the speaker and formatting markup — so a file from a tool like noScribe comes in as clean, timed transcript lines. Any `NOTE` information in the file (such as the transcription tool, the source recording, and the language settings) is kept as a document memo so that context isn't lost.
- **Import noScribe HTML transcripts.** Transcript Import also accepts noScribe's `.html` export, reading each timed segment — with its speaker label and millisecond-accurate timing — as a clean transcript line, and keeping the file's transcription details (tool, source recording, language settings) as a document memo.
- **Auto-code speakers when importing a transcript.** When an imported transcript identifies its speakers (a noScribe HTML export, or a WebVTT file with speaker tags), Magnolia offers to code each speaker's lines for you. A popup lists the detected speakers; drag a code from the Code Browser onto a speaker (or create a new one), and press ▶ to hear a five-second sample to check who it is. Applying codes every one of that speaker's lines.

### Fixed
- **Freshly imported audio and video play reliably after saving.** A media file imported into a project (such as an `.m4a` recording) could fail to play with a "binary not available" error after the project was saved, until the project was closed and reopened. Magnolia now plays imported media straight from the saved project file, so it works immediately.

## [1.6.0]

### Added
- **Relationship Maps work with other QDA software.** Relationship Maps are now saved in the shared REFI-QDA format, so they open as networks in Atlas.ti, and networks made in other tools open in Magnolia — with their nodes, links, and link labels intact and sized to Magnolia's own layout.
- **Audio and video transcripts work with other QDA software.** A media file's synced transcript is now saved in the shared REFI-QDA format, so the transcript — and the codes applied to its text — open in Atlas.ti and come back into Magnolia.
- **Project description.** Project Info now has a Description field that accepts the same Markdown as memos, saved in the shared REFI-QDA format.

### Changed
- **Video transcript coding is now character-precise.** You can code an exact word or phrase in a video's transcript — as you already could with audio and text — instead of a whole line; the code also appears on the video timeline for the span it's spoken.

### Fixed
- **Transcript codes survive a round-trip through Atlas.ti.** A code applied to a video or audio transcript is now written the way Atlas.ti itself stores transcript codes, so it's kept when a project is opened in Atlas, coded further, and brought back — previously the original codes were dropped.
- **Imported transcripts no longer show garbled characters.** Transcript text written in Windows-1252 (as Atlas.ti produces) — curly quotes, apostrophes, dashes, ellipses — is now decoded correctly instead of appearing as "�".
- **Re-importing a transcript's missing media works.** When a project's video or audio file isn't present, the file picker now lets you select it, and re-attaching it keeps the transcript and its codes.
- **PDF area codings work with other QDA software.** Rectangular (box) codings on PDFs are saved as, and imported from, REFI-QDA box selections, so they round-trip with Atlas.ti instead of being turned into text selections or dropped.
- **Standalone codebooks import reliably.** Codes from a `.qdc` codebook are matched correctly regardless of the letter case used in their identifiers.
- **Projects validate against the REFI-QDA schema.** Set membership is written in the order the format requires, so files Magnolia exports are no longer rejected by stricter tools.

## [1.5.1]

### Fixed
- Fixed a bug with regard to the Magnolia icon in the toolbar not showing properly.

## [1.5.0]

### Added
- **Repair a project that's missing its files.** When you open a project whose embedded documents, images, or PDFs aren't actually stored inside it (for example, one saved by an older version), Magnolia now shows a banner listing the affected documents and lets you re-import each one to restore it — keeping its existing codes.
- **Memos work with other QDA software.** Memos are now saved in the shared REFI-QDA format, so Magnolia's memos appear when a project is opened in Atlas.ti or MAXQDA, and memos made in those tools appear in Magnolia. Inside Magnolia each memo still remembers exactly what it is attached to.
- **Scope queries to surveys.** The Document Selector's Type filter now has a Survey option, so a query can be limited to survey sources just like Documents, PDFs, and images.
- **Use text in spatial queries.** The spatial operators (Overlapping, Inside, Outside, Before, Followed by) now accept text terms as inputs — so you can ask, for example, for a word that appears inside a particular phrase or inside a coded passage. Works in documents and surveys.

### Changed
- **Projects are now fully self-contained.** Every file you import — documents, PDFs, images, audio, and video — is stored inside the `.qdpx` project file itself. Magnolia no longer keeps imported media in temporary files on your computer, so a project opens with all its content intact on any machine, and an imported file is written into the project the moment you add it.
- **The toolbar shows the open project's name.** The Magnolia wordmark is now the app icon followed by the current project's name; clicking the name opens Project Info.
- **"Content Memo" is now "Selection Memo"** throughout, to better describe a memo attached to a selection.

### Fixed
- **Imported files can no longer be silently lost.** Magnolia guarantees an imported file's content is written into the project when you save, and refuses to save in a way that would drop it. Re-opening a project restores its media from the project file rather than depending on temporary copies that the system can clear.
- **Projects exported from Magnolia now open in Atlas.ti, and image area-codings appear in MAXQDA.** Image coding coordinates are written as whole numbers, as the interchange format requires; previously the file could be rejected or the codings ignored.
- **Documents and codings from Atlas.ti import correctly.** PDF codes made in Atlas.ti no longer disappear on import, and documents whose stored filename differs from Magnolia's own naming (as Atlas.ti produces) now display and save correctly.

## [1.4.4]

### Added
- **Import button in the toolbar.** Importing documents now has its own dedicated toolbar button, so it's easy to find — it opens the same file picker as before, handling text, PDFs, Word, images, audio/video, and CSV/XLSX surveys.
- **Manual button in the toolbar.** A new button opens Magnolia's online user manual in your browser.
- **Preferences button in the toolbar.** Settings now has its own labelled toolbar button (it previously opened by clicking the Magnolia wordmark). The update-available nudge dot, which used to sit on the wordmark, now appears on this button.

### Changed
- **Toolbar tidy-up.** The toolbar buttons are regrouped as Import / Codebook / Logbook / Tags · Query / Analyse · Studio / Preferences, and the Magnolia wordmark is now simply the app's mark rather than a button.
- **The Query Builder dims the Quotes and Analyses panels** while it's open, signalling that those items can't be dragged into a query — the same treatment Reports already gives its unavailable panels.

### Fixed
- **Code nesting is shown in report tables.** Codes in analysis tables in an exported report (Codes in Documents, Code Frequencies, Code Co-Occurrences) are now indented to reflect their place in the code hierarchy, instead of all appearing on the same level.
- **Dragging a set of codes into a parent keeps their nesting.** Selecting several codes — including a parent and one of its children — and dragging them onto another code no longer flattens the dragged codes; each subtree keeps its existing structure.
- **PDF text selection no longer changes the font.** Selecting text in a PDF (including a Word document converted to PDF) could reveal a different fallback font and even empty boxes for some characters, on Intel Macs in particular. The selectable text layer now stays hidden while selected, so you see only the highlight.
- **The New/Edit Code dialog no longer grows as you type.** Entering a long description kept widening the window; it now stays a fixed width and the description wraps.

## [1.4.3]

### Added
- **Add survey questions, respondents, and answers to a report.** Alongside documents, saved queries, analyses, quotes, and memos, you can now drag individual survey items from the Documents panel onto a report. A question is shown the way it appears in the Survey Overview (its distribution as a donut, option list, or box plot); a respondent is shown as their answers to every question, with their own choice highlighted; and a single answer shows just that question and the respondent's response.

### Changed
- **Report body headings now carry the table-of-contents numbers.** The contents' hierarchical numbering (1, 1.1, 1.1.1) is now repeated on the matching heading in the document, so the two line up.
- **Survey questions and answers in a report flow inline** with the items around them instead of each starting on a fresh page. A whole respondent still begins on its own page.

### Fixed
- **Reports now auto-save.** Changes to a saved report are written back automatically, like everywhere else in Magnolia, rather than only when you press Save.
- **Free-text blocks no longer appear in a report's table of contents**, since they're body prose rather than navigable headings.
- **Total columns line up in exported report tables.** The Total and % of Total cells in an analysis table are now vertically centred to match the rest of the row.

## [1.4.2]

### Added
- **Scope Code Co-Occurrences to specific survey questions.** Like the other analysis tools, Code Co-Occurrences now has a Questions box (shown when a survey is in scope) so you can limit the co-occurrence grid to the answers of one or more questions.

### Fixed
- **Queries and Code Co-Occurrences on surveys now report the right results.** Codings in different survey answers were wrongly treated as overlapping (because each answer's offsets are measured from the start of that answer), which massively inflated co-occurrence counts and query matches, and made query results show the survey's header row instead of the coded answer. Survey codings are now only compared within the same answer cell, and query snippets show the actual coded text.

## [1.4.1]

### Added
- **Add documents to a report.** You can now drag documents from the Documents panel straight onto a report, alongside saved queries, analyses, quotes, and memos. Each document starts on its own page and is included according to its type: text and transcripts appear as their text, an image is embedded scaled to fit the page, a video shows its first frame plus any transcript, a PDF is included as its original pages (scaled to fit), and a survey reproduces the same summary you get from "Export PDF" on the Survey Overview.

### Changed
- **The Documents panel no longer dims while a report is open**, now that documents can be added to a report.

### Fixed
- **Coding a survey answer now lands on exactly the text you selected.** Applying a code to an answer that already had a code could shift the highlight a few characters in (and a code's name in the margin could itself be selected). The margins — code names, brackets, and memo/quote icons — are no longer selectable, so only the answer text can be coded.
- **Selecting a survey answer and releasing the mouse outside the viewer now works.** The selection is kept, and the code applies to that selection rather than to whatever was selected before.
- **Survey question and respondent headers are only clickable on the text itself.** Clicking elsewhere on the header's row no longer jumps to that question or respondent.

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
