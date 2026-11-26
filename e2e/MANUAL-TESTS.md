# Tests to run by hand on Windows and Linux

The automated tests (unit, Rust and the end-to-end specs in `e2e/specs`)
run on Windows, macOS and Linux on every push to GitHub. This list is what
they can't check: real menus and keyboards, screen readers, media codecs,
fonts, the updater, and anything that only shows on a real screen. Each
item says how to check it and what should happen.

**For Claude, on the Windows or Linux machine:** when asked to "do the
Windows tests" (or Linux), work through the items marked for that system
with the user: build and start Magnolia (`npm ci`, then `npm run dev`),
open a copy of a sample project (never the user's own), walk the user
through each step they need to do by hand, and record each result in the
table at the end of this file (date, system, ✅ or ❌ with what happened).
Fix what fails on that machine, then commit both the fix and the updated
table.

Mark items 🪟 for Windows, 🐧 for Linux. Add new items as features are
built that need them; remove an item once it has passed on both systems
since its last change.

## Keyboard and menus

1. 🪟🐧 **Undo and Redo, once per press.** Create a code, then press
   `Ctrl+Z` with the Codes pane selected: the code goes, and only that (one
   step, not two). `Ctrl+Shift+Z` brings it back. The menu's Edit → Undo
   and Redo (if the window shows a menu) do the same.
2. 🪟🐧 **Undo in text.** Type in a text field (a code's name, a memo):
   `Ctrl+Z` undoes the typing, and doesn't undo a change to the project.
3. 🪟🐧 **Menus from the keyboard.** Select a code and press `Shift+F10`
   (and the menu key, if the keyboard has one): the code's menu opens;
   `↑` `↓` and `Enter` choose; `Escape` closes it and the code keeps the
   keyboard.
4. 🪟🐧 **Dragging by copy and paste.** With a code selected press
   `Ctrl+C`, `Tab` to an empty analysis tool's `Results` area and press
   `Ctrl+V`: the code is added, as if dragged. The same for a tag onto a
   document.
5. 🪟🐧 **Coding from the keyboard** in a text document, a PDF (text, and
   an area with the area tool), a picture and a video (`I` and `O` to mark
   a stretch): select, then a code's shortcut (`Ctrl` and its number), and
   the coding appears.

## Windows and the screen

6. 🪟🐧 **The red reminders in the toolbar.** Open a project saved by a
   newer Magnolia (the `newer-format` test makes one), or one locked by
   someone else: the `Read-only` / `Locked` pill sits in the toolbar's
   top-right corner beside the window's own buttons (minimise, maximise,
   close), not under or over them, at any window width.
7. 🪟 **Recent projects show their names.** Open two projects, then
   return to the Welcome screen: each is listed by its name (`Study`), not
   its whole path (`C:\Users\…\Study`).
8. 🪟🐧 **Help → Diagnostics** shows the system's own name for its version
   (Windows: `Microsoft Windows [Version 10.0.…]`; Linux: the
   distribution, such as `Ubuntu 22.04.4 LTS`), and on Windows no console
   window flashes up while it gathers it.

## Documents and media

9. 🪟🐧 **Word, RTF and ODT import** (typeset with Typst): import a
   `.docx` with headings, a table, a picture and some Arabic or Hebrew
   text; it opens as a PDF that looks like the original, its text can be
   selected and coded, and right-to-left lines read the right way.
10. 🪟🐧 **Video and audio play** (`.mp4`, `.mov`, `.mp3`, `.m4a`): they
    play, seek, and show their waveform. On Linux this depends on the
    system's GStreamer codecs; note which formats don't play.

11b. 🐧 **PDF export on KDE Plasma (Wayland), with the system in
    another language** (GitHub #38, reported on CachyOS in Spanish): export
    a report, a query's results and a coded document as PDFs; each file is
    written where the save dialog said. If a PDF can't be made, a message
    says why (it used to fail without a word). The build machine checks
    this on Ubuntu in Spanish, but not with KDE's own save dialog.

## AI Assistance

13. 🪟 **Claude Desktop uses Magnolia** (Windows: Claude Desktop isn't made
    for Linux; on Linux, try another app that supports MCP). In Preferences
    → AI Assistance tick "Let AI apps on this computer use Magnolia" and
    press `Add Magnolia to Claude Desktop`, then quit and reopen Claude
    Desktop: Magnolia is among its connectors. Open a copy of a sample
    project, View → AI Assistance, and in Claude Desktop ask "Suggest codes
    for one of the interviews in my Magnolia project": the pane asks to
    allow it; once allowed, the pane lists what Claude read, the proposals
    appear in the AI Assistance Viewer, and approving one codes the
    passage. On Windows, check that no console window opens when Claude
    Desktop starts the connector.

## Screen readers

11. 🪟 **NVDA**, 🐧 **Orca**: with the screen reader on, move through the
    Codes and Documents panes, open a code's menu with `Shift+F10`, select
    text in a document with `Shift` and the arrows, and open an analysis
    tool. Each item, menu, cell and selection should be read out by name;
    note anything read as "button" or "group" with no name, or not read
    at all.

## Updating

12. 🪟🐧 **The updater** (after the next release is published): from the
    previous version, `Preferences` → `Check for Updates` finds the new
    version, downloads and installs it, and Magnolia restarts into it.
    (Its archive library was replaced in this release.)

## Results

| Date | System | Items | Result |
| --- | --- | --- | --- |
