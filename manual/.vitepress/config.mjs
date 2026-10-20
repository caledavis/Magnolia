import { defineConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Magnolia online manual — VitePress config.
//
// Published as the Magnolia repo's GitHub Pages site at
// https://caledavis.github.io/Magnolia/ , so `base` must be '/Magnolia/'.
// The build output (.vitepress/dist) is deployed by .github/workflows/manual.yml.
//
// TO ADD A NEW PAGE:
//   1. Create a markdown file, e.g. guide/exporting.md
//   2. Add ONE line to the `sidebar` array below: page('Exporting', '/guide/exporting')
// The page's section headings are pulled in automatically — see below.

const guideDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guide')

// VitePress's heading-anchor slug algorithm (from @mdit-vue/shared), inlined so
// the sidebar's heading links match the ids VitePress generates on each page.
function slugify(str) {
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

// Read a page's second-level (##) headings and return them as sidebar sub-items,
// each linking to its anchor on that page. Lines inside code fences are skipped.
function subHeadings(link) {
  const file = path.join(guideDir, link.replace(/^\/guide\//, '') + '.md')
  let md
  try {
    md = fs.readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  const items = []
  let inFence = false
  for (const raw of md.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^##\s+(.+?)\s*$/.exec(raw) // matches `## ` but not `### `
    if (m) {
      items.push({ text: m[1].replace(/`/g, ''), link: `${link}#${slugify(m[1])}` })
    }
  }
  return items
}

// A sidebar page entry. The page is the first-level heading (its title); its
// second-level headings are nested beneath it and shown when the page is active.
function page(text, link) {
  const items = subHeadings(link)
  return items.length ? { text, link, collapsed: true, items } : { text, link }
}

export default defineConfig({
  title: 'Magnolia Manual',
  description: 'The online manual for Magnolia — free, open-source QDA software.',
  lang: 'en-US',

  // GitHub Pages project site path (repo name is "Magnolia", case-sensitive)
  base: '/Magnolia/',

  // Clean URLs (/Magnolia/guide/coding instead of .../coding.html)
  cleanUrls: true,

  // Don't publish helper docs as manual pages — only real content
  srcExclude: ['README.md', 'DEPLOY.md', '**/images/**'],

  // Don't fail the build when a page links to one you haven't written yet.
  // Lets you link ahead to planned pages while drafting. (The link will simply
  // 404 until you create that page.) Set back to false if you'd rather the
  // build catch broken/mistyped links for you.
  ignoreDeadLinks: true,

  // Last-updated timestamps in the footer of each page
  lastUpdated: true,

  // Favicon (the icon lives in public/, served at /Magnolia/magnoliaicon.png)
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/Magnolia/magnoliaicon.png' }]
  ],

  themeConfig: {
    // Built-in local search — no external service needed
    search: {
      provider: 'local'
    },

    // Top navigation bar
    nav: [
      { text: 'Manual', link: '/guide/introduction' },
      { text: 'Magnolia site', link: 'https://www.caledavis.eu/magnolia.html' },
      { text: 'Download', link: 'https://github.com/caledavis/Magnolia/releases/latest' }
    ],

    // === LEFT-HAND TABLE OF CONTENTS ===
    // Each page is added with page('Shown in sidebar', '/path/to/file'). The
    // page's own section headings (##) are pulled in automatically and shown
    // nested beneath it when that page is open.
    // Add a new page by adding one page(...) line here.
    sidebar: [
      {
        text: 'Getting started',
        items: [
          page('Introduction', '/guide/introduction'), // DONE
          page('Installation', '/guide/installation'), // DONE
//          page('Interface', '/guide/interface'),
//          page('Preferences', '/guide/preferences'),
//          page('Logbook', '/guide/logbook'),
        ]
      },
      {
        text: 'Documents',
        items: [
          page('Supported document types and formats', '/guide/supportedformats'), // DONE
          page('Importing documents', '/guide/importing'),  // DONE
//          page('Tags', '/guide/tags'),
        ]
      },
      {
        text: 'Codes',
        items: [
          page('Coding your data', '/guide/coding'),  // DONE
//          page('Organising codes', '/guide/organisingcodes'),
//          page('Codebook', '/guide/codebook'),
        ]
      },
      {
        text: 'Queries and analyses',
        items: [
          page('Querying your data', '/guide/querying'),  // DONE
          page('Selecting Documents', '/guide/documentselector'),  // DONE
          page('Grouping Results', '/guide/grouping'), // DONE
          page('Codes in Documents', '/guide/codesindocuments'), // DONE
          page('Framework Matrix', '/guide/frameworkmatrix'), // DONE
          page('Results in Documents', '/guide/resultsindocuments'), // DONE
          page('Code Co-Occurrences', '/guide/codecooccurrences'), // DONE
          page('Code Orders', '/guide/codeorders'), // DONE
          page('Code Frequencies', '/guide/codefrequencies'), // DONE
          page('Word Frequencies', '/guide/wordfrequencies'), // DONE
          page('Relationships', '/guide/relationships'), // DONE
          page('Reports', '/guide/reports'), // DONE
        ]
      },
      {
        text: 'Memos',
        items: [
          page('What is a memo', '/guide/whatisamemo'), // DONE
          page('Creating memos', '/guide/creatingmemos'), // DONE
        ]
      },
      {
        text: 'Quotes',
        items: [
          page('What is a quote', '/guide/whatisaquote'),  // DONE
          page('Creating quotes', '/guide/creatingquotes'),  // DONE
        ]
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/caledavis/Magnolia' }
    ],

    editLink: {
      pattern: 'https://github.com/caledavis/Magnolia/edit/main/manual/:path',
      text: 'Suggest an edit to this page'
    },

    footer: {
      message: 'Released under the EUPL.',
      copyright: '© 2026 Cale Davis'
    }
  }
})
