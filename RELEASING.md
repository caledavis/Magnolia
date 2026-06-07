# Building & Releasing Magnolia

This file explains two things:

1. **Building** Magnolia for macOS, Windows, and Linux — how to set up each
   machine and produce an installer.
2. **Releasing** — turning those builds into a GitHub release that existing
   users auto-update to.

> Magnolia is built with **electron-vite** (bundles the app) + **electron-builder**
> (packages + signs + publishes). Config lives in the `build` block of
> `package.json`. App id: `com.magnolia.app`. Releases publish to
> `github.com/caledavis/Magnolia`.

---

## 0. Common setup (every platform)

You build for a platform **on that platform** — electron-builder can't
cross-compile a Windows or Linux installer from a Mac. So each OS needs its own
machine (or VM) with:

- **Node.js** — a recent LTS (20+).
- **Git**.
- The repo + dependencies:
  ```sh
  git clone https://github.com/caledavis/Magnolia.git
  cd Magnolia
  npm install
  ```

Two kinds of build command exist for each platform:

| Command | What it does | Use when |
|---|---|---|
| `npm run package:<os>` | Builds + packages locally into `dist/`. **No upload.** | Testing a build, or handing someone an installer directly |
| `npm run release:<os>` | Same, then **uploads** to a GitHub release (needs `GH_TOKEN`) | Cutting an actual release |

Both run `electron-vite build` first automatically.

---

## 1. Building for macOS

**Machine:** any Mac. Apple Silicon can build **both** arm64 and x64 (Rosetta
handles the Intel slice), so one Mac covers all Mac users.

**One-time setup:**

- **Xcode Command Line Tools:** `xcode-select --install`.
- **Developer ID Application certificate** (Team ID `<YOUR_TEAM_ID>`) in your login
  keychain. Check with:
  ```sh
  security find-identity -v -p codesigning   # should list a valid "Developer ID Application"
  ```
  If it says `0 valid identities`, the Apple **"Developer ID Certification
  Authority"** intermediate is probably missing — download it from
  <https://www.apple.com/certificateauthority/> and import it.
- **App-specific password** for your Apple ID (for notarization) — generate at
  <https://appleid.apple.com>.

**Build locally (for testing):**
```sh
npm run package:mac
```
Produces, in `dist/`: `Magnolia-mac-arm64.dmg`, `Magnolia-mac-x64.dmg`, the
matching `.zip`s, and the `.app` bundles under `dist/mac-arm64/` and `dist/mac/`.
Without the Apple env vars (below) it **signs but skips notarization** — fine
for local testing, but Gatekeeper warns on other Macs.

**Sign + notarize:** set these before building/releasing and electron-builder
does it automatically:
```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="<YOUR_TEAM_ID>"
```
Notarization uploads to Apple and waits (~1–5 min), then staples the ticket.

**Verify a finished mac build:**
```sh
spctl -a -vvv -t install dist/mac-arm64/Magnolia.app   # want: source=Notarized Developer ID
xcrun stapler validate dist/mac-arm64/Magnolia.app     # want: The validate action worked!
```

---

## 2. Building for Windows

**Machine:** a Windows PC (or VM). Install **Node.js** + **Git**, then the
[common setup](#0-common-setup-every-platform).

**Build locally (for testing):**
```powershell
npm run package:win
```
Produces `dist\Magnolia-win-x64.exe` (an NSIS installer).

**Notes:**
- Windows builds are currently **unsigned** (no Windows code-signing certificate
  is set up). Users get a **SmartScreen "unknown publisher"** warning on first
  run → *More info → Run anyway*. The app is otherwise fine. (Adding Windows
  signing later is a separate task: an EV/OV code-signing cert + `win.certificateFile`.)
- The window has no native title bar (it's frameless), so Magnolia draws its own
  **minimise / maximise / close** buttons in the top-right of the toolbar.

---

## 3. Building for Linux

**Machine:** a Linux box (x64). Install **Node.js** + **Git**, then the
[common setup](#0-common-setup-every-platform).

**Build locally (for testing):**
```sh
npm run package:linux
```
Produces `dist/Magnolia-linux-x86_64.AppImage` and `dist/Magnolia-linux-amd64.deb`
(electron-builder names Linux artifacts by architecture convention — `x86_64`
for AppImage, `amd64` for `.deb` — **not** `x64`).

**Notes:**
- The **AppImage** is portable — `chmod +x` it and run; no install needed.
- The **.deb** is for Debian/Ubuntu (`sudo apt install ./Magnolia-linux-amd64.deb`).
- On a minimal Linux you may need a couple of packaging tools for the `.deb`
  (e.g. `fakeroot`, `dpkg`); electron-builder fetches most of what it needs.
- Linux builds are **unsigned** (Linux has no Gatekeeper-style requirement).
- Frameless window → Magnolia draws its own window controls, same as Windows.

---

## 4. Cutting a release

A release is the same build as above, but published to GitHub so installed
copies auto-update. All platforms for one version land in a **single**
`vX.Y.Z` GitHub release.

**Prerequisite:** a **GitHub Personal Access Token** (classic) with the `repo`
scope — <https://github.com/settings/tokens>. It only needs to live for the
publish step.

**Steps:**

1. **Bump the version** in `package.json` ([SemVer](https://semver.org/): major =
   breaking project-file changes, minor = features, patch = fixes):
   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```
2. **Commit + push** the bump on its own:
   ```sh
   git commit -am "Bump version to X.Y.Z" && git push
   ```
3. **Build + publish on each platform.** Export the token (and, on macOS, the
   Apple vars) in the shell first, then run the platform's `release` script.
   Make sure every machine is on the **same commit** (`git pull` first).

   **macOS:**
   ```sh
   export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="<YOUR_TEAM_ID>"
   npm run release:mac
   ```
   **Windows (PowerShell):**
   ```powershell
   $env:GH_TOKEN = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   npm run release:win
   ```
   **Linux:**
   ```sh
   export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   npm run release:linux
   ```
   The first `release:*` to run **creates** the `vX.Y.Z` draft; the others add
   their assets to that same draft.
4. **Write the release notes.** Open the draft at
   <https://github.com/caledavis/Magnolia/releases>, and write a short
   **"What's new"** in the release body. **These notes now appear inside the
   app** — Magnolia's update dialog renders the GitHub release body (markdown)
   when it prompts the user to update. So make them user-facing and tidy.
5. **Publish** the draft. Until you do, auto-updaters can't see it.
6. **Verify** — see "What gets uploaded" and the auto-update notes below.

---

## What gets uploaded

Filenames are **version-less** (set via `artifactName` in `package.json`) so the
README's `…/releases/latest/download/…` links stay valid across versions.

| File | Platform | Purpose |
|---|---|---|
| `Magnolia-mac-arm64.dmg` / `-x64.dmg` | macOS | Drag-to-Applications installers (Apple Silicon / Intel) |
| `Magnolia-mac-arm64.zip` / `-x64.zip` | macOS | Auto-update payloads |
| `latest-mac.yml` | macOS | Update manifest the app polls — **must** be present |
| `Magnolia-win-x64.exe` | Windows | NSIS installer |
| `latest.yml` | Windows | Windows update manifest |
| `Magnolia-linux-x86_64.AppImage` / `Magnolia-linux-amd64.deb` | Linux | Installers |
| `latest-linux.yml` | Linux | Linux update manifest |
| `*.blockmap` | all | Differential-update metadata |

---

## Auto-update — important notes

- **macOS auto-update was broken in 1.0.0–1.0.6 and fixed in 1.0.7.** Squirrel.Mac
  submits its installer helper (ShipIt) but never starts it on modern macOS, so
  the update downloaded but never installed. Magnolia now starts that job itself
  (`startShipItJob()` in `src/main/auto-updater.ts`). **Consequence:** the fix
  only helps updates *from* a build that contains it. Anyone still on **1.0.0–1.0.6
  must download the new version manually once** (drag from the DMG); every update
  from 1.0.7 onward is automatic. Mention this in release notes while old
  versions are still in the wild.
- **An updater fix only takes effect from the build that ships it.** To verify
  any change to the update flow, install the fixed build first, *then* release a
  higher version and update from it — you can't verify it from an older build.
- **Don't skip the version bump.** If `package.json` matches the installed
  version, electron-updater sees no upgrade and stays put.
- **The draft release is invisible** to auto-updaters until you click Publish.
- **Stopgap if a macOS install ever gets stuck** (downloaded but not applied):
  quit the app, then `launchctl start com.magnolia.app.ShipIt` completes it.

---

## Skipping a platform

To ship, say, a macOS-only update and roll Windows/Linux later, just run
`release:mac` alone. Clients only consume the `latest-*.yml` for their own
platform, so partial releases are safe — but the README's download link for a
skipped platform will point at the previous version until you catch it up.

---

## Pre-release / beta channel

Not wired yet. To enable later: set `autoUpdater.allowPrerelease = true` in
`src/main/auto-updater.ts`, and tag GitHub releases with `-beta.N` suffixes.
Beta users pick up tagged pre-releases; everyone else stays on stable.
(macOS signing/notarization applies to any channel; Windows/Linux signing is
still TODO.)
