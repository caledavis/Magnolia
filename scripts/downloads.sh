#!/usr/bin/env bash
# Report GitHub release download counts for Magnolia.
#
# Prints the total number of installer downloads (the .dmg / .exe / .deb /
# .rpm / .AppImage assets), then a per-asset-type breakdown. Updater files
# (latest.json, latest*.yml, *.app.tar.gz, *.zip, *.sig, *.blockmap) are
# excluded. Since the move to Tauri, the Windows .exe and Linux AppImage are
# also the update payloads, so from then on those two counts include updates.
#
# Also prints auto-updater check-in counts for the current latest release, as
# a rough proxy for live/active installs (see comment below for caveats).
#
# Requires the GitHub CLI (`gh`) and `jq`, installed and authenticated:
#   brew install gh jq && gh auth login
#
# Usage: scripts/downloads.sh   (or: npm run downloads, if wired up)

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

# Pull every release's assets once, reuse for both the total and the breakdown.
assets="$(gh api "repos/${REPO}/releases" --paginate \
  --jq '.[].assets[] | [.name, .download_count] | @tsv')"

installer_re='\.(dmg|exe|deb|rpm|AppImage)$'

total="$(printf '%s\n' "$assets" \
  | awk -F'\t' -v re="$installer_re" '$1 ~ re { sum += $2 } END { print sum + 0 }')"

echo "Installer downloads (.dmg/.exe/.deb/.rpm/.AppImage): ${total}"
echo
echo "By platform:"
printf '%s\n' "$assets" | awk -F'\t' '
  $1 ~ /\.dmg$/                      { mac += $2 }
  $1 ~ /\.exe$/                      { win += $2 }
  $1 ~ /\.deb$|\.rpm$|\.AppImage$/   { lin += $2 }
  END {
    total = mac + win + lin
    printf "  Sum:                 %d\n", total
    printf "  macOS (.dmg):        %d\n", mac + 0
    printf "  Windows (.exe):      %d\n", win + 0
    printf "  Linux (.deb/.rpm/.App): %d\n", lin + 0
  }'

# Updater check-ins for the current latest release: a rough proxy for live
# installs. Tauri builds poll latest.json (one manifest for all platforms);
# Magnolia 1.x (electron-updater) polls latest.yml / latest-mac.yml /
# latest-linux.yml. Counts are pings received *while this version has held the
# "latest" spot* and reset to zero with every new release.
latest="$(gh api "repos/${REPO}/releases/latest")"
latest_tag="$(printf '%s' "$latest" | jq -r '.tag_name')"
manifests="$(printf '%s' "$latest" \
  | jq -r '.assets[] | select(.name | test("^latest.*\\.(yml|json)$")) | [.name, .download_count] | @tsv')"

echo
echo "Updater check-ins for latest release (${latest_tag}):"
printf '%s\n' "$manifests" | awk -F'\t' '
  $1 == "latest.json"      { tauri = $2 }
  $1 == "latest-mac.yml"   { mac = $2 }
  $1 == "latest.yml"       { win = $2 }
  $1 == "latest-linux.yml" { lin = $2 }
  END {
    printf "  Tauri builds (all platforms): %d\n", tauri + 0
    printf "  Magnolia 1.x macOS:          %d\n", mac + 0
    printf "  Magnolia 1.x Windows:        %d\n", win + 0
    printf "  Magnolia 1.x Linux:          %d\n", lin + 0
  }'
