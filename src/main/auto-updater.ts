/**
 * Auto-update wiring (electron-updater + GitHub Releases).
 *
 * Behaviour:
 *   - On app ready (after a short delay so the main window is up),
 *     check for an update silently in the background.
 *   - If one is available, download in the background. The user is
 *     told nothing yet — no popup interrupts their work.
 *   - When the download finishes, surface a non-blocking dialog
 *     asking the user to restart now or later. "Later" leaves the
 *     update queued; it'll install automatically on the next quit.
 *   - The Help menu's "Check for updates…" item routes through the
 *     same flow but, when nothing's available, surfaces a confirmation
 *     dialog so the user knows the check happened.
 *
 * Publishing model: releases are uploaded to
 * https://github.com/caledavis/Magnolia/releases by running
 * `npm run release:mac` (or release:win / release:linux) with the
 * GH_TOKEN env var set to a personal access token that can write
 * releases on the repo. electron-builder uploads the .dmg / .zip /
 * .exe / .AppImage / .deb plus latest*.yml manifests.
 *
 * Dev mode: electron-updater no-ops automatically when running from
 * `electron-vite dev` (because there's no app.asar to compare versions
 * against), so this module is safe to import unconditionally.
 */
import { app, BrowserWindow, dialog, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFileSync } from 'child_process'

/**
 * Workaround for a Squirrel.Mac bug on modern macOS (see electron #25626).
 * After quitAndInstall(), Squirrel *submits* the ShipIt launchd job
 * (`<appId>.ShipIt`) but never *starts* it — `launchctl print` shows runs=0,
 * "never exited" — so the staged update is never applied and the app doesn't
 * relaunch. We start the job ourselves while the app is still alive; ShipIt
 * then waits for this process to exit and performs the install + relaunch.
 * (A manual `launchctl start` reliably completes the otherwise-stuck install.)
 * The job label is the electron-builder appId + ".ShipIt".
 */
function startShipItJob(): void {
  if (process.platform !== 'darwin') return
  try {
    // launchctl start returns immediately (fire-and-forget); it does not block
    // until the job finishes, so this can't deadlock against ShipIt waiting on
    // us to quit.
    execFileSync('/bin/launchctl', ['start', 'com.magnolia.app.ShipIt'])
  } catch {
    // No job submitted (nothing staged) or already running — nothing to do.
  }
}

let mainWindowRef: BrowserWindow | null = null
let manualCheckInProgress = false
// Called right before quitAndInstall() so the main process can mark itself as
// intentionally quitting (otherwise the window's `closed` handler re-opens the
// Welcome screen and the macOS update can't install — see below).
let onQuitForUpdateRef: (() => void) | null = null
// Set once an update has been downloaded + staged. Lets the app-quit handlers
// kick ShipIt for the "Later → install on quit" path, which on macOS goes
// through the native Squirrel.Mac auto-install and hits the same
// submitted-but-never-started ShipIt bug as quitAndInstall.
let updateDownloaded = false
let quitHandlersAdded = false

/** Initialise the updater and schedule a startup check. Must be
 *  called after app.whenReady() resolves. The reference to the main
 *  window lets us route dialogs through it (so they sit above the
 *  app rather than alone in the dock). */
export function initAutoUpdater(mainWindow: BrowserWindow, onQuitForUpdate: () => void): void {
  mainWindowRef = mainWindow
  onQuitForUpdateRef = onQuitForUpdate

  // "Later → install on quit": when the app quits with a staged update,
  // Squirrel.Mac is meant to install it on quit, but it hits the same
  // submitted-but-never-started ShipIt bug as quitAndInstall. Kick the job
  // ourselves as the app shuts down. Guarded by updateDownloaded so a normal
  // quit (nothing staged) does nothing; idempotent so it's harmless if the
  // Restart-now path already kicked, or if both will-quit and quit fire.
  if (!quitHandlersAdded) {
    quitHandlersAdded = true
    const kickShipItOnQuit = (): void => {
      if (updateDownloaded) startShipItJob()
    }
    app.on('will-quit', kickShipItOnQuit)
    app.on('quit', kickShipItOnQuit)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Suppress prerelease pickup. We're on a single stable channel for
  // 1.0; revisit when there's a beta channel to surface.
  autoUpdater.allowPrerelease = false

  autoUpdater.on('update-available', (info) => {
    // Silent; the download proceeds in the background.
    console.log('[auto-update] available:', info.version)
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('[auto-update] up to date:', info.version)
    if (manualCheckInProgress) {
      manualCheckInProgress = false
      dialog.showMessageBox(mainWindowRef ?? undefined as any, {
        type: 'info',
        message: 'Magnolia is up to date',
        detail: `Version ${info.version} is the latest available.`,
        buttons: ['OK']
      })
    }
  })

  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err)
    if (manualCheckInProgress) {
      manualCheckInProgress = false
      dialog.showMessageBox(mainWindowRef ?? undefined as any, {
        type: 'error',
        message: 'Could not check for updates',
        detail: err?.message ?? String(err),
        buttons: ['OK']
      })
    }
  })

  autoUpdater.on('update-downloaded', async (info) => {
    manualCheckInProgress = false
    updateDownloaded = true
    // Subtle OS notification first — non-blocking, won't pull focus
    // mid-coding-session.
    if (Notification.isSupported()) {
      new Notification({
        title: 'Magnolia update ready',
        body: `Version ${info.version} will install when you quit, or restart now to install immediately.`
      }).show()
    }
    const { response } = await dialog.showMessageBox(mainWindowRef ?? undefined as any, {
      type: 'info',
      message: `Magnolia ${info.version} is ready to install`,
      detail: 'Restart now to apply the update, or quit later — it will install automatically on next launch.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) {
      // Mark the app as intentionally quitting BEFORE quitAndInstall. On macOS,
      // electron-updater's quitAndInstall closes the main window but does not
      // reliably fire before-quit / before-quit-for-update, so without this the
      // main window's `closed` handler re-opens the Welcome screen, the app
      // keeps running, and Squirrel can never install the staged update.
      onQuitForUpdateRef?.()
      autoUpdater.quitAndInstall()
      // quitAndInstall submitted the ShipIt launchd job but, on modern macOS,
      // won't start it — kick it ourselves so the update actually installs.
      startShipItJob()
    }
  })

  // Don't block startup: give the app a few seconds to settle before
  // hitting the network.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[auto-update] startup check failed:', err)
    })
  }, 5_000)
}

/** Triggered by the Help → "Check for updates…" menu item. Same flow
 *  as the startup check, but with user-visible feedback when nothing
 *  is available so they know the check actually happened. */
export function checkForUpdatesManually(): void {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindowRef ?? undefined as any, {
      type: 'info',
      message: 'Update checks are disabled in development',
      detail: 'Run a packaged build (`npm run package:mac/win/linux`) to test the update flow.',
      buttons: ['OK']
    })
    return
  }
  manualCheckInProgress = true
  autoUpdater.checkForUpdates().catch((err) => {
    manualCheckInProgress = false
    console.error('[auto-update] manual check failed:', err)
    dialog.showMessageBox(mainWindowRef ?? undefined as any, {
      type: 'error',
      message: 'Could not check for updates',
      detail: err?.message ?? String(err),
      buttons: ['OK']
    })
  })
}
