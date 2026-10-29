#!/usr/bin/env bash
# Report GitHub release download counts for Magnolia.
#
# Prints:
#   - Total downloads: installer downloads (.dmg / .exe / .deb / .rpm /
#     .AppImage) across every release. Since the move to Tauri, the Windows
#     .exe and Linux AppImage are also the update payloads, so from then on
#     those count updates too.
#   - Total auto-updater downloads: how many times the updater fetched the
#     current latest release's manifest, a rough proxy for live installs.
#   - The auto-updater downloads by OS.
#
# Requires the GitHub CLI (`gh`) and `jq`, installed and authenticated:
#   brew install gh jq && gh auth login
#
# Usage: scripts/downloads.sh   (or: npm run downloads)

set -euo pipefail

REPO="caledavis/Magnolia"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) not found. Install with: brew install gh" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found. Install with: brew install jq" >&2
  exit 1
fi

total="$(gh api "repos/${REPO}/releases" --paginate \
  --jq '.[].assets[] | [.name, .download_count] | @tsv' \
  | awk -F'\t' '$1 ~ /\.(dmg|exe|deb|rpm|AppImage)$/ { sum += $2 } END { print sum + 0 }')"

echo "Total downloads: ${total}"

# Updater manifest downloads for the current latest release. Tauri builds poll
# latest.json (one manifest for all platforms, so it can't be split by OS);
# Magnolia 1.x (electron-updater) polls latest-mac.yml / latest.yml /
# latest-linux.yml. Counts are pings received *while this version has held the
# "latest" spot* and reset to zero with every new release.
latest="$(gh api "repos/${REPO}/releases/latest")"
latest_tag="$(printf '%s' "$latest" | jq -r '.tag_name')"

printf '%s' "$latest" \
  | jq -r '.assets[] | select(.name | test("^latest.*\\.(yml|json)$")) | [.name, .download_count] | @tsv' \
  | awk -F'\t' -v tag="$latest_tag" '
  $1 == "latest.json"      { tauri = $2 }
  $1 == "latest-mac.yml"   { mac = $2 }
  $1 == "latest.yml"       { win = $2 }
  $1 == "latest-linux.yml" { lin = $2 }
  END {
    printf "Total auto-updater downloads (%s): %d\n", tag, tauri + mac + win + lin
    printf "  macOS:   %d\n", mac + 0
    printf "  Windows: %d\n", win + 0
    printf "  Linux:   %d\n", lin + 0
    if (tauri > 0) printf "  Tauri builds (any OS): %d\n", tauri
  }'
