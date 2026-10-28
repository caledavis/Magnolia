# Building & Releasing Magnolia

This file explains two things:

1. **Building** Magnolia for macOS, Windows, and Linux — how to set up each
   machine and produce an installer.
2. **Releasing** — turning those builds into a GitHub release that existing
   users auto-update to.

> Magnolia is a **Tauri 2** app: a Rust backend (`src-tauri/`, with the
> REFI-QDA / conversion core in `crates/magnolia-core/`) around the React
> renderer (`src/renderer/`, bundled by Vite). Bundling, signing and
> updater config live in `src-tauri/tauri.conf.json`. App id:
> `com.magnolia.app`. Releases publish to `github.com/caledavis/Magnolia`.

---

## 0. Common setup (every platform)

You build for a platform **on that platform** (Tauri can't cross-compile
installers). Each machine needs:

- **Node.js** — a recent LTS (20+).
- **Rust** — stable, via <https://rustup.rs>.
- **Git**.
- The repo + dependencies:
  ```sh
  git clone https://github.com/caledavis/Magnolia.git
  cd Magnolia
  npm install
  ```

Everyday commands:

| Command | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload |
| `npm test` | Renderer tests (Vitest) + backend tests (`cargo test`) |
| `npm run typecheck` | TypeScript check of the renderer |
| `npm run build` | Release build + installers for this platform, into `target/…/release/bundle/` |

The GitHub **Build** workflow (`.github/workflows/build.yml`) compiles and
tests all three platforms on every push, so a Windows or Linux breakage shows
up there even if you only develop on a Mac.

### The updater signing key

Tauri only installs updates whose signature matches the public key built
into the app (`plugins.updater.pubkey` in `tauri.conf.json`). The private
key lives at `~/.tauri/magnolia-updater.key` on the Mac it was generated on
(no password).

- **Back it up somewhere safe** (a password manager). If it's lost, installed
  copies can never verify another update and users must reinstall by hand.
- Copy it to each build machine, then export it before a release build:
  ```sh
  export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/magnolia-updater.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  ```
  (PowerShell: `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\magnolia-updater.key`.)
  Without it the build still works but stops with "no private key" at the
  end, and produces no update payload.

---

## 1. Building for macOS

**Machine:** any Mac. Apple Silicon builds **both** arm64 and x64.

**One-time setup:**

- **Xcode Command Line Tools:** `xcode-select --install`.
- **Both Rust targets:** `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- **Developer ID Application certificate** in your login keychain. Check with:
  ```sh
  security find-identity -v -p codesigning   # should list a valid "Developer ID Application"
  ```
  If it says `0 valid identities`, the Apple **"Developer ID Certification
  Authority"** intermediate is probably missing — download it from
  <https://www.apple.com/certificateauthority/> and import it.
- **App-specific password** for your Apple ID (for notarization) — generate at
  <https://appleid.apple.com>.

**Sign + notarize:** set these before building and Tauri signs, notarizes and
staples automatically:
```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Your Name> (<YOUR_TEAM_ID>)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # the app-specific password
export APPLE_TEAM_ID="<YOUR_TEAM_ID>"
```
Without them the build is unsigned — fine for local testing, but Gatekeeper
blocks it on other Macs.

**Build:**
```sh
npm run tauri build -- --target aarch64-apple-darwin
npm run tauri build -- --target x86_64-apple-darwin
```
Each produces, under `target/<target>/release/bundle/`: the `.app`, a `.dmg`,
and (with the signing key set) the update payload `Magnolia.app.tar.gz` +
`.sig`.

The `.dmg` step drives Finder with AppleScript to lay out the window, so run
it from a terminal that has **Automation** permission for Finder (System
Settings → Privacy & Security → Automation); otherwise it fails with
"AppleEvent timed out".

**Verify a finished build:**
```sh
spctl -a -vvv -t install target/aarch64-apple-darwin/release/bundle/macos/Magnolia.app   # want: source=Notarized Developer ID
xcrun stapler validate target/aarch64-apple-darwin/release/bundle/macos/Magnolia.app     # want: The validate action worked!
```

---

## 2. Building for Windows

**Machine:** a Windows PC (or VM) with **Node.js**, **Rust** and **Git**, plus
the "Desktop development with C++" workload from the Visual Studio Build
Tools (Rust's MSVC toolchain needs it). WebView2 ships with Windows 10/11;
the installer bootstraps it on machines that lack it.

**Build:**
```powershell
npm run build
```
Produces `target\release\bundle\nsis\Magnolia_X.Y.Z_x64-setup.exe` (+ `.sig`
with the signing key set).

**Notes:**
- Windows builds are **unsigned** (no Windows code-signing certificate is set
  up). Users get a **SmartScreen "unknown publisher"** warning on first run →
  *More info → Run anyway*.
- Tauri has no "portable" single-exe target, so the old
  `Magnolia-win-portable-x64.exe` download is gone; the installer installs
  per-user without admin rights.
- The window has no native title bar, so Magnolia draws its own
  **minimise / maximise / close** buttons in the toolbar.

---

## 3. Building for Linux

**Machine:** an x64 Linux box with **Node.js**, **Rust**, **Git**, and the
WebKitGTK development packages. On Debian/Ubuntu:
```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```

**Build:**
```sh
npm run build
```
Produces under `target/release/bundle/`: `appimage/…AppImage` (+ `.sig`),
`deb/…deb`, and `rpm/…rpm`.

**Notes:**
- The **AppImage** is portable — `chmod +x` it and run. It needs **libfuse2**
  on the host (see the README's Troubleshooting section); the `.deb`/`.rpm`
  pull in their own dependencies, including WebKitGTK.
- Linux builds are **unsigned** (beyond the updater signature).
- No native title bar → Magnolia draws its own window controls.

---

## 4. Cutting a release

All platforms for one version land in a **single** `vX.Y.Z` GitHub release.
You need the [`gh` CLI](https://cli.github.com) logged in to an account that
can write releases.

1. **Bump the version** in `package.json` ([SemVer](https://semver.org/):
   major = breaking project-file changes, minor = features, patch = fixes).
   `src-tauri/tauri.conf.json` reads the version from there:
   ```sh
   npm version X.Y.Z --no-git-tag-version
   git commit -am "Bump version to X.Y.Z" && git push
   ```
2. **Create the draft release** (once, from any machine):
   ```sh
   gh release create vX.Y.Z --draft --title "Magnolia X.Y.Z" --notes ""
   ```
3. **Build, collect and upload on each platform** (all on the same commit;
   signing key and, on macOS, the Apple variables exported):
   ```sh
   # macOS
   npm run tauri build -- --target aarch64-apple-darwin
   npm run tauri build -- --target x86_64-apple-darwin
   node scripts/release.mjs collect mac-arm64
   node scripts/release.mjs collect mac-x64

   # Windows
   npm run build
   node scripts/release.mjs collect win

   # Linux
   npm run build
   node scripts/release.mjs collect linux
   ```
   `collect` copies the bundles into `release/` under stable, version-less
   names (so the README's `…/releases/latest/download/…` links keep
   working). Then upload them:
   ```sh
   gh release upload vX.Y.Z release/*
   ```
4. **Write the release notes** in the draft's body on GitHub, and save the
   same text to a file (e.g. `notes.md`). **These notes appear inside the
   app** — the update dialog renders them (markdown) — so keep them
   user-facing.
5. **Generate the update manifests** from all the uploaded assets:
   ```sh
   rm -rf assets && gh release download vX.Y.Z -D assets
   node scripts/release.mjs manifests X.Y.Z assets notes.md
   gh release upload vX.Y.Z assets/latest.json assets/latest*.yml --clobber
   ```
   - `latest.json` is what Tauri builds poll.
   - `latest-mac.yml`, `latest.yml` and `latest-linux.yml` are for installs of
     **Magnolia 1.x (Electron)**, whose updater only reads those — see
     "Moving users off Electron" below. `latest-mac.yml` carries
     `minimumSystemVersion: '22.0.0'` (Darwin 22 = macOS 13), so Macs too old
     to run the build aren't offered it.
6. **Publish** the draft. Until you do, updaters can't see it.

---

## What gets uploaded

| File | Platform | Purpose |
|---|---|---|
| `Magnolia-mac-arm64.dmg` / `-x64.dmg` | macOS | Drag-to-Applications installers |
| `Magnolia-mac-arm64.app.tar.gz` / `-x64…` (+ `.sig`) | macOS | Tauri update payloads |
| `Magnolia-mac-arm64.zip` / `-x64.zip` | macOS | Update payloads for Magnolia 1.x |
| `Magnolia-win-x64.exe` (+ `.sig`) | Windows | Installer, and the update payload for both updaters |
| `Magnolia-linux-x86_64.AppImage` (+ `.sig`) | Linux | Portable app, and the update payload |
| `Magnolia-linux-amd64.deb` / `Magnolia-linux-x86_64.rpm` | Linux | Packages |
| `latest.json` | all | Tauri update manifest |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | all | Update manifests for Magnolia 1.x |

---

## Moving users off Electron

Magnolia 1.x used electron-updater. The `latest*.yml` manifests that
`scripts/release.mjs manifests` writes let those installs update straight to
the Tauri build:

- **macOS:** Squirrel.Mac installs the zipped `.app` only if it is signed with
  the **same Developer ID** as the installed 1.x app, so always release
  signed builds. Preferences and recent projects carry over (same
  `~/Library/Application Support/Magnolia` folder).
- **Windows:** electron-updater runs the new installer silently. Tauri installs
  per-user into a different folder than Electron did, so the old copy's
  uninstaller entry stays in "Installed apps" until the user removes it;
  shortcuts point at the new app.
- **Linux:** the AppImage is replaced in place; `.deb`/`.rpm` users update with
  their package manager as before.

Keep publishing the `.yml` manifests and `.zip`s for a few releases, until
1.x installs have died out. Once the Tauri build is installed, all updates go
through `latest.json`.

---

## Auto-update — important notes

- **Don't skip the version bump.** If `package.json` matches the installed
  version, the updater sees no upgrade.
- **The draft release is invisible** to updaters until you click Publish.
- **An updater change only takes effect from the build that ships it.** To
  verify a change to the update flow, install the fixed build first, then
  release a higher version and update from it.
- **Release builds only.** Update checks are disabled in `npm run dev`; set
  `MAGNOLIA_FORCE_UPDATE_BADGE=1` there to preview the toolbar badge.

---

## Skipping a platform

To ship, say, a macOS-only update, build and collect just that platform and
run `manifests` on what's in the release: platforms without assets are simply
left out of `latest.json`, so their installs stay on the previous version.
The README's download link for a skipped platform keeps pointing at the
previous version's file until you catch it up.
