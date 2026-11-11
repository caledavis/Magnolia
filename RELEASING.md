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
installers). Releases need only the Mac: Windows and Linux are built on
GitHub's machines. Each machine you build on needs:

- **Node.js** — a recent LTS (24+; the GitHub workflows use 24).
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
| `npm run build` | Release build + installers for this platform, into `target/…/release/bundle/` (for testing; nothing is uploaded) |
| `npm run release:mac` | macOS release: builds arm64 + x64, collects and uploads to the draft (see "Cutting a release") |
| `npm run release:win` | Windows release, from any machine: runs the **Release (Windows)** workflow on GitHub, which builds, tests and uploads (see "Building for Windows") |
| `npm run release:linux` | Linux release, from any machine: runs the **Release (Linux)** workflow on GitHub, which builds on Ubuntu 22.04, tests and uploads (see "Building for Linux") |
| `npm run release:finish` | Writes and uploads the update manifests, once every platform is uploaded and the draft has its notes |

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
- **Copy it to each build machine** at the same place: `~/.tauri/magnolia-updater.key`
  (on Windows, `%USERPROFILE%\.tauri\magnolia-updater.key`). The
  `release:*` commands load it from there by themselves.
- **Add it to GitHub** as the repository secret `TAURI_SIGNING_PRIVATE_KEY`,
  for the Windows and Linux release workflows (once):
  ```sh
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo caledavis/Magnolia < ~/.tauri/magnolia-updater.key
  ```
- Only a plain `npm run build` needs it exported, if you want that build to
  carry an update payload:
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

**Sign + notarize:** export your Apple ID and its app-specific password,
as for the Electron builds:
```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```
Tauri then signs, notarizes and staples automatically. `npm run release:mac`
fills in the rest: it signs with Magnolia's Developer ID, "Developer ID
Application: Cale Davis (DTRLLXT8T7)", unless `APPLE_SIGNING_IDENTITY` and
`APPLE_TEAM_ID` are set to another, and passes the password on as
`APPLE_PASSWORD` (Tauri's name for it). It stops without the Apple ID and
password, since an unsigned build couldn't update Magnolia 1.x. (electron-builder
found the certificate in the keychain by itself; Tauri needs its name.)

**Build a release:** `npm run release:mac` builds both architectures, collects
and uploads them (see "Cutting a release").

**Build by hand** (for testing): a plain `tauri build` isn't signed unless
you also export `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` and
`APPLE_PASSWORD` yourself; unsigned is fine on your own Mac, but Gatekeeper
blocks it on others.
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

**Build a release on GitHub; no Windows PC is needed.** The **Release
(Windows)** workflow (`.github/workflows/release-windows.yml`) builds on
GitHub's Windows machines, installs the result silently on a clean one and
checks Magnolia starts and keeps running, and only then uploads the
installer and its `.sig` to the draft release. Start it with
`npm run release:win` once the draft exists and your commit is pushed: like
`release:linux`, it runs the workflow for GitHub's `main`, follows it in the
terminal, stops with the run's link if anything fails, and refuses to start
if your checkout isn't what's on `main`. (You can also run it from the
Actions tab; untick **upload** to build and test without uploading.) It
needs the `TAURI_SIGNING_PRIVATE_KEY` secret (see "The updater signing
key"). The smoke test catches an app that won't start; it can't tell
whether the interface looks right, so try a build on a real PC now and then.

**Machine for local builds** (testing only): a Windows PC (or VM) with
**Node.js**, **Rust** and **Git**, plus the "Desktop development with C++"
workload from the Visual Studio Build Tools (Rust's MSVC toolchain needs
it). WebView2 ships with Windows 10/11; the installer bootstraps it on
machines that lack it. `npm run release:win -- --no-upload` builds and
collects there, without uploading.

**Build by hand** (for testing):
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

**Build a release on GitHub, not on your own Linux machine.** An AppImage
bundles most libraries from the machine it's built on, but takes glibc,
libgpg-error and a few others from the user's system. Built on a recent
distro, it needs that distro's glibc (so it won't start on Ubuntu 22.04 or
Debian 12) and bundles a libgcrypt that an older libgpg-error can't satisfy
(issue #31: `undefined symbol: gpgrt_add_post_log_func`). 2.0.0 was built
this way and has both problems.

The **Release (Linux)** workflow (`.github/workflows/release-linux.yml`)
builds on Ubuntu 22.04 instead, starts the AppImage on clean Ubuntu 22.04,
Ubuntu 24.04 and Debian 12 to check it loads, and only then uploads the
AppImage, `.deb` and `.rpm` to the draft release (no `.rpm` for a test
build such as `2.1.0-beta.1`: RPM doesn't allow a hyphen in a version).
Start it with
`npm run release:linux` once the draft exists and your commit is pushed:
it runs the workflow for GitHub's `main`, follows it in the terminal, and
stops with the run's link if anything fails. It refuses to start if your
checkout isn't what's on `main`, so the Linux build is always of the same
commit as the others. (You can also run the workflow from the Actions tab.)
It needs the `TAURI_SIGNING_PRIVATE_KEY` secret (see "The updater signing
key"). Untick **upload** to build and test without uploading. To check an
AppImage that's already published, fill in **check_release** (e.g.
`v2.0.0`): it skips the build and only runs the smoke test.

**Machine for local builds** (testing only): an x64 Linux box with
**Node.js**, **Rust**, **Git**, and the WebKitGTK development packages. On
Debian/Ubuntu:
```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```
`npm run release:linux -- --no-upload` builds and collects there, without
uploading. Don't upload such a build: the release has to come from the
workflow.

**Build by hand** (for testing):
```sh
npm run build
```
Produces under `target/release/bundle/`: `appimage/…AppImage`, `deb/…deb` and
`rpm/…rpm`, each with a `.sig`.

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
can write releases, on every build machine.

**In short:**
```sh
npm version X.Y.Z --no-git-tag-version   # and version = "X.Y.Z" in src-tauri/Cargo.toml
(cd src-tauri && cargo build) && git commit -am "Bump version to X.Y.Z" && git push
gh release create vX.Y.Z --draft --title "Magnolia X.Y.Z" --notes ""

# On the Mac (after exporting APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD):
npm run release:mac
# Windows and Linux, from any machine (they build on GitHub; see
# "Building for Windows" and "Building for Linux"):
npm run release:win
npm run release:linux

# Anywhere, once all three are uploaded and the notes are written on GitHub:
npm run release:finish
# Then publish the draft on GitHub.
```

The steps in detail:

1. **Bump the version** in `package.json` ([SemVer](https://semver.org/):
   major = breaking project-file changes, minor = features, patch = fixes).
   `src-tauri/tauri.conf.json` reads the version from there. `npm version`
   doesn't touch `src-tauri/Cargo.toml`, so set its `version` to match too,
   and build once so `Cargo.lock` follows:
   ```sh
   npm version X.Y.Z --no-git-tag-version
   # edit src-tauri/Cargo.toml: version = "X.Y.Z"
   (cd src-tauri && cargo build)
   git commit -am "Bump version to X.Y.Z" && git push
   ```
2. **Create the draft release** (once, from any machine):
   ```sh
   gh release create vX.Y.Z --draft --title "Magnolia X.Y.Z" --notes ""
   ```
3. **Build and upload each platform** (all on the same commit, pushed to
   `main`). From the Mac:
   ```sh
   npm run release:mac     # macOS: both arm64 and x64
   ```
   ```sh
   npm run release:win     # Windows, from any machine: builds on GitHub
   npm run release:linux   # Linux, from any machine: builds on GitHub
   ```
   `release:win` and `release:linux` run the **Release (Windows)** and
   **Release (Linux)** workflows on GitHub instead of building locally, and
   upload to the same draft once their smoke tests pass.
   Each builds the installers and update payloads, collects them into
   `release/` under stable, version-less names (so the README's
   `…/releases/latest/download/…` links keep working), and uploads them to
   the `vX.Y.Z` draft (the version in `package.json`). It loads the updater
   key from `~/.tauri/magnolia-updater.key` unless `TAURI_SIGNING_PRIVATE_KEY`
   is set. On macOS, export your Apple ID and app-specific password first
   (as for the Electron builds):
   ```sh
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   ```
   `release:mac` signs with Magnolia's Developer ID (Cale Davis,
   DTRLLXT8T7) unless `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID` say
   otherwise, and stops without the Apple ID and password, since an
   un-notarized build couldn't update Magnolia 1.x. Add `-- --no-upload` to
   build and collect without uploading.
4. **Write the release notes** in the draft's description on GitHub. **These
   notes appear inside the app** — the update dialog renders them
   (markdown) — so keep them user-facing.
5. **Generate the update manifests** once every platform is uploaded and the
   notes are written:
   ```sh
   npm run release:finish
   ```
   It downloads the draft's assets, takes the notes from the draft's
   description (or from a file: `npm run release:finish -- notes.md`),
   writes the manifests and uploads them. If you change the notes
   afterwards, run it again. Electron's builds wrote their `latest*.yml`
   as each platform was built; Tauri's `latest.json` lists every
   platform's signed update, so it can only be written once all are
   uploaded.
   - `latest.json` is what Tauri builds poll.
   - `latest-mac.yml`, `latest.yml` and `latest-linux.yml` are for installs of
     **Magnolia 1.x (Electron)**, whose updater only reads those — see
     "Moving users off Electron" below. `latest-mac.yml` carries
     `minimumSystemVersion: '22.0.0'` (Darwin 22 = macOS 13), so Macs too old
     to run the build aren't offered it.

   The steps underneath, if you need them on their own:
   `node scripts/release.mjs collect <mac-arm64|mac-x64|win|linux>` and
   `node scripts/release.mjs manifests X.Y.Z <assets-dir> notes.md`.
6. **Publish** the draft. Until you do, updaters can't see it.

---

## What gets uploaded

| File | Platform | Purpose |
|---|---|---|
| `Magnolia-mac-arm64.dmg` / `-x64.dmg` | macOS | Drag-to-Applications installers |
| `Magnolia-mac-arm64.app.tar.gz` / `-x64…` (+ `.sig`) | macOS | Tauri update payloads |
| `Magnolia-mac-arm64.zip` / `-x64.zip` | macOS | Update payloads for Magnolia 1.x |
| `Magnolia-win-x64.exe` (+ `.sig`) | Windows | Installer, and the update payload for both updaters |
| `Magnolia-linux-x86_64.AppImage` (+ `.sig`) | Linux | Portable app, and the update payload for AppImages |
| `Magnolia-linux-amd64.deb` / `Magnolia-linux-x86_64.rpm` (+ `.sig`) | Linux | Packages, and the update payloads for deb and rpm installs |
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
  After installing, Squirrel.Mac can't relaunch the app: it looks for
  `Squirrel.framework` inside the new bundle, which a Tauri app doesn't
  have. Magnolia quits and stays closed until the user opens it again. 1.x
  shows the GitHub release body in its update dialog, so the **first Tauri
  release's notes must say so**, e.g.:
  > **Updating from Magnolia 1.x on a Mac:** Magnolia will close to finish
  > the update and won't reopen by itself. Open it again from your
  > Applications folder; your projects and preferences are kept.
- **Windows:** electron-updater runs the new installer silently. Tauri installs
  per-user into a different folder than Electron did, so the old copy's
  uninstaller entry stays in "Installed apps" until the user removes it;
  shortcuts point at the new app.
- **Linux:** the AppImage is replaced in place; 1.x `.deb`/`.rpm` installs can't
  update themselves, so those users install the 2.x package by hand once. After
  that, the app updates them itself: `latest.json` has `linux-x86_64-deb` and
  `linux-x86_64-rpm` entries, and the app asks for a password to install them.

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

## Testing an update before release

Updaters only see a **published** release, so rehearse against a local
server first. Nothing here touches GitHub. Example: the real release is
2.0.0, and a throwaway 2.0.1 stands in for "the next version".

**Build the two versions** (signing key and Apple variables exported):
```sh
npm version 2.0.0 --no-git-tag-version
npm run tauri build -- --target aarch64-apple-darwin
node scripts/release.mjs collect mac-arm64
mkdir -p ~/update-test && mv release ~/update-test/2.0.0

npm version 2.0.1 --no-git-tag-version     # throwaway; don't commit it
npm run tauri build -- --target aarch64-apple-darwin
node scripts/release.mjs collect mac-arm64
mv release ~/update-test/2.0.1
echo "Test release notes — **markdown** works." > ~/update-test/notes.md
git checkout package.json package-lock.json src-tauri/Cargo.toml   # back to the real version
```

### Tauri → Tauri (`latest.json`)

1. Install 2.0.0: open `~/update-test/2.0.0/Magnolia-mac-arm64.dmg` and drag
   it to Applications.
2. Write the 2.0.1 manifest with local download links, and serve it:
   ```sh
   node scripts/release.mjs manifests 2.0.1 ~/update-test/2.0.1 ~/update-test/notes.md --base-url http://localhost:8000/
   python3 -m http.server 8000 -d ~/update-test/2.0.1
   ```
3. Launch 2.0.0 pointed at it (quit Magnolia first):
   ```sh
   open -n --env MAGNOLIA_UPDATE_ENDPOINT=http://localhost:8000/latest.json /Applications/Magnolia.app
   ```
   `MAGNOLIA_UPDATE_ENDPOINT` makes a release build check that manifest
   instead of GitHub's. Signatures are still checked against the built-in
   key.
4. Check: the prompt appears with the notes; Remind Me Later; Skip This
   Version (then Help → Check for Updates… still offers it); Install Update
   → progress → Cancel; Install Update again → Install and Relaunch; the
   relaunched app's About says 2.0.1. Reinstall 2.0.0 and also check
   "close the window when Ready to Install, then quit" installs on quit.
   The server log shows each request.

### Electron 1.x → Tauri (`latest-mac.yml`)

1. Get a 1.9.0 copy and point its updater at the local server. Editing
   the bundle breaks its signature, so re-sign it with the **same Developer
   ID** (Squirrel.Mac only installs an update whose signer matches):
   ```sh
   gh release download v1.9.0 -p 'Magnolia-*arm64*.zip' -D ~/update-test/1.9.0
   rm -rf /Applications/Magnolia.app   # ditto merges into an existing bundle
   ditto -x -k ~/update-test/1.9.0/*.zip /Applications
   printf 'provider: generic\nurl: http://localhost:8000/\nupdaterCacheDirName: magnolia-updater\n' \
     > /Applications/Magnolia.app/Contents/Resources/app-update.yml
   codesign --force --deep --options runtime --preserve-metadata=entitlements \
     --sign "Developer ID Application: Cale Davis (DTRLLXT8T7)" /Applications/Magnolia.app
   ```
2. Write the 2.0.0 manifests and serve them:
   ```sh
   node scripts/release.mjs manifests 2.0.0 ~/update-test/2.0.0 ~/update-test/notes.md --base-url http://localhost:8000/
   python3 -m http.server 8000 -d ~/update-test/2.0.0
   ```
3. Open 1.9.0 and let it update. Check: the Tauri 2.0.0 launches
   afterwards, preferences and recent projects are still there.

Back up `~/Library/Application Support/Magnolia` before testing and restore
it afterwards, since every run reads and writes it. Remove
`/Applications/Magnolia.app` when done and install the real release.

### On Linux

The two rehearsals below use the **AppImage**, the only Linux build that
updates itself from 1.x. The steps above carry over with these changes.

**Tauri → Tauri, deb or rpm:** install the older package, put the newer
package and its `.sig` with the other assets, write and serve the manifests as
above, then run `MAGNOLIA_UPDATE_ENDPOINT=http://localhost:8000/latest.json magnolia`.
Install and Relaunch asks for your password, installs the package and reopens
on the new version. Cancel the password prompt once too: the update window
should say the install failed, and closing it should reopen the old version.

**Build the two versions** the same way, with the signing key exported and
only the Linux bundles:
```sh
npm run tauri build -- --bundles appimage,deb,rpm
node scripts/release.mjs collect linux
```

**Tauri → Tauri:** there's nothing to install. Copy the 2.0.0 AppImage
(the updater overwrites whichever file it was started from, so keep the
original for the install-on-quit run), write and serve the 2.0.1 manifests
as above, then:
```sh
cp ~/update-test/2.0.0/Magnolia-linux-x86_64.AppImage ~/update-test/Magnolia-under-test.AppImage
MAGNOLIA_UPDATE_ENDPOINT=http://localhost:8000/latest.json ~/update-test/Magnolia-under-test.AppImage
```
Over localhost the 120 MB download finishes in about a second, too fast to
press Cancel. Serve it through a rate-limited server (~5 MB/s) for that step.

**Electron 1.x → Tauri (`latest-linux.yml`):** nothing is signed, so
instead of re-signing, extract 1.9.0, edit its `app-update.yml`, and run
the extracted app with `APPIMAGE` set to a copy of the original. That copy
is the file electron-updater replaces and relaunches:
```sh
gh release download v1.9.0 -p 'Magnolia-linux-x86_64.AppImage' -D ~/update-test/1.9.0
cd ~/update-test/1.9.0 && chmod +x Magnolia-linux-x86_64.AppImage
./Magnolia-linux-x86_64.AppImage --appimage-extract
printf 'provider: generic\nurl: http://localhost:8000/\nupdaterCacheDirName: magnolia-updater\n' \
  > squashfs-root/resources/app-update.yml
cp Magnolia-linux-x86_64.AppImage ~/update-test/Magnolia-linux-x86_64.AppImage
APPIMAGE=$HOME/update-test/Magnolia-linux-x86_64.AppImage squashfs-root/AppRun
```
With the 2.0.0 manifests served, 1.9.0 downloads the update on its own
and installs it when you quit or restart. Expect two things in its log:
- A `RangeError … Received NaN` from the differential download. The Tauri
  AppImage has no embedded blockmap, so electron-updater falls back to a
  full download. That's harmless.
- The update is written under the release's file name. A user who renamed
  their 1.9.0 AppImage ends up with `Magnolia-linux-x86_64.AppImage` and
  loses the old file, along with any launcher pointing at it. Keep the
  copy under the release name, as above, to test an in-place update.

Back up `~/.config/Magnolia` (shared by the Electron and Tauri builds)
before testing and restore it afterwards. The Tauri tests add
`magnolia-update-state.json` there, which holds Skip This Version.

---

## Skipping a platform

To ship, say, a macOS-only update, run just `npm run release:mac`, then
`npm run release:finish`: platforms without assets in the release are simply
left out of `latest.json`, so their installs stay on the previous version.
The README's download link for a skipped platform keeps pointing at the
previous version's file until you catch it up.
