// Layout checks that run inside Magnolia's main window, injected by the
// debug-only MAGNOLIA_AUTOMATION hook (src-tauri/src/automation.rs). The
// runner (run.mjs) prepends OUT (the capture folder), ONLY (the checks to
// run) and PROJECT (names in the project to open).
//
// Lines logged as "ISSUE …" or "OVERFLOW …" are problems; "INFO …" lines
// are measurements. Captures are whole-window PNGs plus a rect to crop to.
;(async () => {
  if (window.top !== window || window.__checksStarted) return
  window.__checksStarted = true
  await new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r)))
  addEventListener('error', (e) => window.__TAURI_INTERNALS__.invoke('automation_log', { message: 'JSERROR ' + e.message }))

  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const log = (m) => call('automation_log', { message: String(m) })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (el) => !!el && el.offsetParent !== null
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
  const lang = () => document.documentElement.lang

  async function waitFor(fn, what, timeout = 15000) {
    const end = Date.now() + timeout
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > end) throw new Error('timed out waiting for ' + what)
      await sleep(150)
    }
  }
  /** The visible element whose own text is exactly `text`. */
  const byText = (text, root = document) => [...root.querySelectorAll('*')].find((e) => visible(e) && ownText(e) === text)
  function press(el) {
    for (const t of ['mousedown', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
    el.click()
  }
  const open = async (el) => { press(el); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await sleep(2000) }
  const setSize = (w, h = 1000) => call('automation_set_size', { width: w, height: h })
  const full = () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })
  /** Capture the window and log the rect (CSS px) to crop to. */
  async function shot(name, rect = full) {
    await sleep(500)
    const r = rect()
    await call('automation_capture', { path: `${OUT}/${name}.png` })
    await log('RECT ' + JSON.stringify({ name, x: r.x, y: r.y, width: r.width, height: r.height, innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio }))
  }
  const rb = (id) => document.querySelector(`.ribbon-btn[data-ribbon-id="${id}"]`)
  const tab = async (i) => { press(document.querySelectorAll('.ribbon-tab')[i]); await sleep(400) }
  const esc = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400) }
  const backdrop = async () => { const el = document.elementFromPoint(6, innerHeight - 6); el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el?.click(); await sleep(500) }
  const openDocument = async () => { const d = byText(PROJECT.document); if (d) await open(d); else await log('INFO no document "' + PROJECT.document + '" in the project') }

  const checks = {
    // The main window in the current language, with a document open.
    async screenshot() {
      await setSize(1400, 1000); await sleep(1200)
      await openDocument()
      await shot('Window-' + lang())
    },

    // Every ribbon tab at a tall, short, narrow and narrow-short window:
    // a label wider than its button, on more than two lines, or overlapping
    // its neighbour; then a forced overflow to try the scroll chevrons.
    async ribbon() {
      const l = lang()
      for (const [w, h, size] of [[1400, 1000, 'tall'], [1400, 800, 'short'], [900, 1000, 'narrow'], [900, 800, 'narrowshort']]) {
        await setSize(w, h); await sleep(900)
        const tabs = [...document.querySelectorAll('.ribbon-tab')]
        const strip = document.querySelector('.ribbon-tabs')
        if (strip.scrollWidth > strip.clientWidth + 1) await log(`ISSUE ${l} ${size} tab strip overflows ${strip.scrollWidth}>${strip.clientWidth}`)
        for (let i = 0; i < tabs.length; i++) {
          press(tabs[i]); await sleep(500)
          let prev = null
          for (const b of document.querySelectorAll('.ribbon-body .ribbon-btn')) {
            const label = b.querySelector('.ribbon-label')
            const lh = parseFloat(getComputedStyle(label).lineHeight) || parseFloat(getComputedStyle(label).fontSize) * 1.2
            // The label's text extent, which may spill past the button.
            const range = document.createRange(); range.selectNodeContents(label)
            const tr = range.getBoundingClientRect()
            const lines = Math.round(tr.height / lh)
            const name = label.textContent.trim()
            const bw = b.getBoundingClientRect().width
            if (tr.width > bw + 0.5) await log(`ISSUE ${l} ${size} [${tabs[i].textContent}] "${name}" wider than its button ${tr.width.toFixed(0)}>${bw.toFixed(0)}`)
            if (lines > 2) await log(`ISSUE ${l} ${size} [${tabs[i].textContent}] "${name}" on ${lines} lines`)
            if (prev && tr.left < prev.right - 0.5 && tr.right > prev.left + 0.5 && tr.top < prev.bottom && tr.bottom > prev.top) await log(`ISSUE ${l} ${size} [${tabs[i].textContent}] "${name}" overlaps the previous label`)
            prev = tr
          }
          const body = document.querySelector('.ribbon-body')
          const scroller = document.querySelector('.ribbon-scroll')
          if (scroller.scrollWidth > scroller.clientWidth + 1) await log(`INFO ${l} ${size} [${tabs[i].textContent}] scrolls ${scroller.scrollWidth}>${scroller.clientWidth} tight=${body.dataset.tight}`)
          await shot(`Ribbon-${l}-${size}-${i}`, () => {
            const a = strip.getBoundingClientRect(), b2 = body.getBoundingClientRect()
            return { x: 0, y: a.top, width: innerWidth, height: b2.bottom - a.top }
          })
        }
      }
      await setSize(1400, 1000); await sleep(900)
      await tab(1)
      const force = document.createElement('style')
      force.textContent = '.ribbon-btn { min-width: 200px !important }'
      document.head.appendChild(force); await sleep(800)
      const hints = () => [...document.querySelectorAll('.ribbon-scroll-hint')].map((h) => (h.dataset.shown !== undefined ? 'shown' : 'hidden'))
      const sc = document.querySelector('.ribbon-scroll')
      const atStart = hints().join()
      document.querySelectorAll('.ribbon-scroll-hint')[1]?.click(); await sleep(900)
      const moved = sc.scrollLeft !== 0
      if (atStart !== 'hidden,shown' || !moved) await log(`ISSUE ${l} scroll chevrons: at the start ${atStart}; the end chevron ${moved ? 'scrolls' : 'does not scroll'}`)
      force.remove(); await sleep(900)
    },

    // The ribbon check with the page forced right to left.
    async 'ribbon-rtl'() {
      document.documentElement.dir = 'rtl'
      await checks.ribbon()
    },

    // Open each view in turn and log text that overflows its box: spills,
    // is clipped without an ellipsis, is clipped by an ancestor, or
    // overlaps a sibling. Wrapping isn't flagged, so look at the captures.
    async ui() {
      const l = lang()
      await setSize(1400, 1000); await sleep(1200)
      const seen = new Set()
      /** Where an element's text shows: its text's extent, cut to its own
       *  box when that box hides overflow (an ellipsis, say). */
      const shownText = (node) => {
        const r = document.createRange(); r.selectNodeContents(node)
        const t = r.getBoundingClientRect()
        if (getComputedStyle(node).overflowX === 'visible') return t
        const b = node.getBoundingClientRect()
        return { left: Math.max(t.left, b.left), right: Math.min(t.right, b.right), top: t.top, bottom: t.bottom, width: Math.max(0, Math.min(t.right, b.right) - Math.max(t.left, b.left)) }
      }
      const report = async (view, kind, el, extra = '') => {
        const key = kind + '|' + ownText(el).slice(0, 60)
        if (seen.has(key)) return
        seen.add(key)
        await log(`OVERFLOW ${l} [${view}] ${kind}${extra} "${ownText(el).slice(0, 70)}"`)
      }
      const check = async (view) => {
        await sleep(700)
        for (const el of document.querySelectorAll('body *')) {
          if (!visible(el) || !ownText(el)) continue
          const cs = getComputedStyle(el)
          if (cs.display === 'inline' || cs.display === 'contents') continue
          if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') || el.closest('[contenteditable="true"], textarea, svg, .ProseMirror, .user-text, [data-coding-overlay]')) continue
          const overW = el.scrollWidth - el.clientWidth
          const overH = el.scrollHeight - el.clientHeight
          const clipsX = cs.overflowX !== 'visible', clipsY = cs.overflowY !== 'visible'
          // Scrollable boxes are meant to scroll.
          if (/auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflowY)) continue
          const txt = shownText(el)
          // Clipped by an ancestor that hides overflow (not one that scrolls).
          let kind = null
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const as = getComputedStyle(a)
            if (as.overflowX === 'visible' && as.overflowY === 'visible') continue
            if (/auto|scroll/.test(as.overflowX + as.overflowY)) break
            const ar = a.getBoundingClientRect()
            if (txt.width > 0 && (txt.right > ar.right + 2 || txt.left < ar.left - 2)) kind = 'clipped by ' + (a.className || a.tagName).toString().split(' ')[0]
            break
          }
          // Overlapping a sibling's text; freely positioned things (canvas
          // nodes, floating buttons) may overlap by design.
          if (!kind && el.parentElement) {
            for (const sib of el.parentElement.children) {
              if (sib === el || !visible(sib) || !sib.textContent.trim()) continue
              if (/absolute|fixed/.test(getComputedStyle(sib).position + cs.position)) continue
              const st = shownText(sib)
              if (st.width && txt.width && txt.left < st.right - 2 && txt.right > st.left + 2 && txt.top < st.bottom - 2 && txt.bottom > st.top + 2) { kind = 'overlaps "' + sib.textContent.trim().slice(0, 25) + '"'; break }
            }
          }
          if (kind) { await report(view, kind, el); continue }
          if (overW > 2) kind = clipsX ? 'clipped' : 'spills'
          else if (overH > 3 && clipsY) kind = 'clipped vertically'
          if (!kind) continue
          // Spilling only matters if the text actually leaves its parent.
          if (kind === 'spills') {
            const pr = el.parentElement.getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(el)
            const tr = r.getBoundingClientRect()
            if (tr.right <= pr.right + 1 && tr.left >= pr.left - 1) continue
          }
          await report(view, kind, el, ` +${Math.max(overW, overH)}px`)
        }
      }
      await check('main')
      for (const t of [0, 1, 2, 3]) { await tab(t); await check('ribbon tab ' + t) }
      // Every analysis tool, empty.
      await tab(1)
      for (const id of [...document.querySelectorAll('.ribbon-body .ribbon-btn')].map((b) => b.dataset.ribbonId)) {
        await tab(1); press(rb(id)); await sleep(1500); await check('tool ' + id)
      }
      await tab(0); press(rb('query')); await sleep(1800); await check('query builder')
      await shot('Ui-' + l + '-query-builder')
      // Context menus on a document and a code.
      const menu = async (el, name) => {
        if (!el) return log(`INFO no "${name}" in the project`)
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }))
        await check('menu on ' + name); await esc(); await backdrop()
      }
      await menu(byText(PROJECT.document), PROJECT.document)
      await menu(byText(PROJECT.code), PROJECT.code)
      // Preferences, every category.
      await tab(0); press(rb('preferences')); await sleep(1500)
      for (const c of document.querySelectorAll('[data-pref-cat]')) { press(c); c.click(); await check('preferences ' + c.dataset.prefCat) }
      press(document.querySelector('[data-pref-cat="general"]')); await sleep(600)
      await shot('Ui-' + l + '-preferences')
      // Dialogs last, each closed by its backdrop.
      for (const [t, id] of [[0, 'tags'], [0, 'project-details'], [3, 'licence']]) {
        await tab(t); press(rb(id)); await sleep(1200); await check(id)
        await shot(`Ui-${l}-${id}`)
        await esc(); await backdrop()
      }
    },

    // Exports: a saved query's results as PDF and Word Frequencies as CSV
    // (saved to OUT without a dialog), and a PDF of Arabic, Chinese, Hindi
    // and Russian text from the same PDF engine. Look at the files.
    async pdf() {
      const l = lang()
      const q = byText(PROJECT.query)
      if (q) {
        await open(q); await sleep(1000)
        const btn = await waitFor(() => [...document.querySelectorAll('button.secondary')].find((b) => visible(b) && b.textContent.includes('PDF') && b.title), 'the PDF export button')
        press(btn); await sleep(6000)
        await log('INFO exported the query results as PDF')
      } else await log(`INFO no saved query "${PROJECT.query}" in the project`)
      await tab(1); press(rb('word-frequencies')); await sleep(2500)
      const csv = await waitFor(() => [...document.querySelectorAll('button')].find((b) => visible(b) && b.textContent.includes('CSV')), 'the CSV export button')
      press(csv); await sleep(2000)
      await log('INFO exported Word Frequencies as CSV')
      const para = (lg, t) => `<p lang="${lg}" dir="auto">${t}</p>`
      const html = `<!DOCTYPE html><html lang="${l}" dir="${document.documentElement.dir}"><head><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;font-size:12px} td,th{border:1px solid #ccc;padding:4px;text-align:start} p,td,th{unicode-bidi:plaintext}</style></head><body>
        <h1>Scripts</h1>
        ${para('ar', 'أعتقد أن المدرسة ليست جيدة جدا للطلاب في هذه المدينة، لكن المعلمين يساعدوننا كثيرا (حوالي ٥٠٠ دولار). هل هذا كافٍ؟')}
        ${para('zh', '我们的学生很喜欢这个大学。但是生活费用太高了，大约每月五百美元。')}
        ${para('hi', 'मुझे लगता है कि यह विश्वविद्यालय छात्रों के लिए अच्छा है। लेकिन रहने का ख़र्च बहुत अधिक है।')}
        ${para('ru', 'Студенты учатся в библиотеке каждый день, но жильё стоит слишком дорого.')}
        <table><tr><th>الرمز</th><th>Code</th><th>代码</th><th>%</th></tr><tr><td>العزلة والوحدة</td><td>Isolation &amp; loneliness</td><td>孤立与孤独</td><td>12,5 %</td></tr></table>
        </body></html>`
      await call('automation_pdf', { html, path: `${OUT}/Scripts-${l}.pdf` })
      await log('INFO wrote Scripts-' + l + '.pdf')
    },

    // The document bar of every document in the project at three window
    // widths: a control that spills out of the bar, or a bar that wraps.
    async 'document-bar'() {
      const l = lang()
      const rows = [...document.querySelectorAll('[data-document-guid]')]
      for (const w of [1400, 1000, 760]) {
        await setSize(w, 1000); await sleep(1200)
        for (const row of rows) {
          const name = row.textContent.trim()
          await open(row); await sleep(1200)
          const bar = [...document.querySelectorAll('.document-bar')].find(visible)
          if (!bar) {
            // A survey has no bar; capture its summary instead.
            await log(`INFO ${l} ${w} no document bar for ${name}`)
            await shot(`Bar-${w}-${rows.indexOf(row)}-page`)
            // Hover the second option of the first donut with several
            // segments: its segment should pop out and glow.
            const donut = [...document.querySelectorAll('svg')].find((g) => visible(g) && g.querySelectorAll('.donut-seg').length > 2)
            const item = donut?.parentElement?.querySelectorAll('li')[1]
            if (item) {
              item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
              await sleep(400)
              await shot(`Donut-${w}`, () => { const r = donut.parentElement.getBoundingClientRect(); return { x: r.x - 20, y: r.y - 20, width: r.width + 40, height: r.height + 40 } })
              item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
            }
            continue
          }
          const b = bar.getBoundingClientRect()
          for (const el of bar.children) {
            const r = el.getBoundingClientRect()
            if (r.width && (r.left < b.left - 1 || r.right > b.right + 1)) await log(`ISSUE ${l} ${w} ${name}: ${el.className || el.tagName} spills out of the bar`)
          }
          const tops = new Set([...bar.children, ...(bar.querySelector('.document-bar-controls')?.children ?? [])].filter((e) => e.getBoundingClientRect().width).map((e) => Math.round(e.getBoundingClientRect().top / 8)))
          const nameEl = bar.querySelector('.document-bar-name, .note-title-input')
          await log(`INFO ${l} ${w} ${name}: bar ${Math.round(b.width)}x${Math.round(b.height)}, ${tops.size} line(s), name ${Math.round(nameEl?.getBoundingClientRect().width ?? 0)}px`)
          await shot(`Bar-${w}-${rows.indexOf(row)}`, () => { const r = bar.getBoundingClientRect(); return { x: r.x, y: r.y - 4, width: r.width, height: r.height + 60 } })
        }
      }
    },

    // Every document in the project exported from its Export menu as a
    // PDF with its codes, then as a PDF without them.
    async 'coded-pdf'() {
      await setSize(1400, 1000); await sleep(1200)
      const rows = [...document.querySelectorAll('[data-document-guid]')]
      for (const row of rows) {
        const name = row.textContent.trim()
        await open(row); await sleep(1500)
        await shot('CodedPdf-' + rows.indexOf(row))
        for (const withCodes of [true, false]) {
          const menuButton = [...document.querySelectorAll('[data-export-menu]')].find(visible)
          if (!menuButton) { await log('ISSUE no Export menu for ' + name); break }
          press(menuButton); await sleep(400)
          // A click that lands while the document is still settling can
          // miss; try once more.
          if (!document.querySelector('[data-export-coded-pdf]')) { press(menuButton); await sleep(600) }
          if (withCodes) await shot('ExportMenu-' + rows.indexOf(row))
          const coded = document.querySelector('[data-export-coded-pdf]')
          // The export without codes is the item after the one with them.
          const item = withCodes ? coded : coded?.nextElementSibling
          if (!item) { await log('ISSUE no PDF export ' + (withCodes ? 'with' : 'without') + ' codes for ' + name); break }
          press(item)
          // Wait for the export to finish (the button reads "Exporting…" meanwhile).
          await sleep(1500)
          await waitFor(() => !document.querySelector('[data-export-menu][disabled]'), 'the export of ' + name, 120000)
          await sleep(3000)
          await log('INFO exported ' + name + (withCodes ? ' with' : ' without') + ' codes')
        }
      }
    },

    // The page forced right to left: the main window, a tool and a document.
    async 'rtl-ui'() {
      await setSize(1400, 1000); await sleep(1200)
      document.documentElement.dir = 'rtl'
      await sleep(1200)
      await shot('Rtl-main')
      await tab(1); press(rb('code-frequencies')); await sleep(1500)
      await shot('Rtl-tool')
      await openDocument()
      await shot('Rtl-document')
    },

    // Right-to-left text: import a mixed Arabic and English document by a
    // file drop, open it, and capture it.
    async 'rtl-text'() {
      const text = [
        'تجربة الطلاب في الجامعة',
        'أعتقد أن المدرسة ليست جيدة جدا للطلاب في هذه المدينة، لكن المعلمين يساعدوننا كثيرا. هل هذا كافٍ؟',
        'This paragraph is in English, and should read left to right.',
        'الطلاب يدرسون في المكتبة كل يوم، ويقولون إن تكلفة السكن مرتفعة جدا (حوالي 500 دولار شهريا).'
      ].join('\n')
      const dt = new DataTransfer()
      dt.items.add(new File([text], 'مقابلة.txt', { type: 'text/plain' }))
      const target = document.querySelector('.app-toolbar')
      for (const t of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }))
      await sleep(2500)
      await open(await waitFor(() => byText('مقابلة.txt') || byText('مقابلة'), 'the imported document'))
      await shot('RtlText-' + lang())
    }
  }

  try {
    await log('started')
    await waitFor(() => document.querySelector('.app-toolbar'), 'the app', 60000)
    await sleep(1000)
    for (const [name, run] of Object.entries(checks)) {
      if (!ONLY.includes(name)) continue
      await log('checking ' + name)
      try { await run() } catch (e) { await log('ISSUE ' + lang() + ' the ' + name + ' check failed: ' + (e?.message ?? e)) }
    }
  } catch (e) {
    await log('ISSUE ' + (e?.message ?? e))
  }
  await log('done')
  await call('automation_quit')
})()
