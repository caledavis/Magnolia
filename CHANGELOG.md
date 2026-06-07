# Changelog

All notable changes to Magnolia are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows [Semantic Versioning](https://semver.org/).

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
