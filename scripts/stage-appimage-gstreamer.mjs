#!/usr/bin/env node
/**
 * Stages the GStreamer plugins the Linux AppImage bundles, and their
 * packages' copyright notices. Tauri runs it as it's about to bundle
 * (build.beforeBundleCommand); it does nothing except on Debian or Ubuntu.
 *
 * - target/appimage-gstreamer/plugins: links to just the plugins
 *   Magnolia's players use. linuxdeploy's GStreamer plugin bundles every
 *   plugin in the folder GSTREAMER_PLUGINS_DIR names, with everything they
 *   link, so the release build points it here: given the system's own
 *   folder, it took all 280-odd, and with them an AI runtime, Python, GTK 4
 *   and a dozen encoders, more than doubling the AppImage.
 * - target/appimage-gstreamer/notices/<package>/copyright: the notices of
 *   the packages those plugins come from, which linuxdeploy leaves out (it
 *   copies those of the libraries it bundles, not of the plugins), for
 *   tauri.conf.json (bundle.linux.appimage.files) to put in usr/share/doc.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'target', 'appimage-gstreamer')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'plugins'), { recursive: true })
mkdirSync(join(OUT, 'notices'), { recursive: true })

const SYSTEM = '/usr/lib/x86_64-linux-gnu/gstreamer-1.0'
if (process.platform !== 'linux' || !existsSync(SYSTEM)) process.exit(0)

// What WebKit builds playback from, for the formats Magnolia imports (MP4,
// MOV, M4A, AAC, AVI, WebM, MP3, WAV, Ogg, FLAC), by plugin file (libgst
// <name>.so). Names differ between GStreamer versions (videoconvert and
// videoscale became videoconvertscale in 1.22), so missing ones are skipped.
const NEEDED = [
  // The pipeline itself: playbin, decodebin, typefinding, WebKit's app sinks.
  'coreelements', 'typefindfunctions', 'playback', 'app', 'autodetect',
  // Audio: conversion, speed changes (scaletempo), mixing for Web Audio, output.
  'audioconvert', 'audioresample', 'audiorate', 'volume', 'audiofx', 'audiomixer', 'interleave',
  'pulseaudio', 'alsa',
  // Video: conversion, scaling, rotation, frame rate, and drawing (OpenGL).
  'videoconvert', 'videoscale', 'videoconvertscale', 'videofilter', 'videorate', 'opengl',
  // Containers and parsers.
  'isomp4', 'matroska', 'avi', 'wavparse', 'ogg', 'id3demux', 'apetag', 'audioparsers', 'videoparsersbad',
  // Decoders: FFmpeg (H.264, H.265, AAC, MPEG-4…), VP8/VP9, Opus, Vorbis, FLAC, MP3.
  'libav', 'vpx', 'opus', 'vorbis', 'flac', 'mpg123',
  // WebKit's stand-in sinks (fakevideosink, fakeaudiosink), and timestamps
  // for its WebCodecs decoders.
  'debugutilsbad', 'codectimestamper',
]

const staged = []
for (const name of NEEDED) {
  const file = join(SYSTEM, `libgst${name}.so`)
  if (!existsSync(file)) continue
  symlinkSync(file, join(OUT, 'plugins', `libgst${name}.so`))
  staged.push(file)
}
console.log(`Staged ${staged.length} GStreamer plugins for the AppImage`)

// "gstreamer1.0-libav:amd64: /usr/lib/…/libgstlibav.so"
const owned = spawnSync('dpkg', ['-S', ...staged], { encoding: 'utf8', maxBuffer: 16 << 20 })
const packages = new Set((owned.stdout || '').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean))
const noticed = []
for (const pkg of [...packages].sort()) {
  const notice = join('/usr/share/doc', pkg, 'copyright')
  if (!existsSync(notice)) continue
  mkdirSync(join(OUT, 'notices', pkg), { recursive: true })
  copyFileSync(notice, join(OUT, 'notices', pkg, 'copyright'))
  noticed.push(pkg)
}
console.log(`Staged the copyright notices of ${noticed.join(', ')}`)
