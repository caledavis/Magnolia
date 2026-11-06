#!/usr/bin/env bash
# Report how many times the current (latest) Magnolia release has been
# downloaded, per OS, counting both fresh installs and auto-updates:
#
#   macOS:   .dmg (installer), .zip (1.x updater), .app.tar.gz (2.x updater)
#   Windows: .exe (installer and update payload)
#   Linux:   .deb / .rpm / .AppImage (each is also its own update payload)
#
# Update manifests (latest*.yml / latest.json) and .sig files are left out:
# they're fetched on every update check, not when the app is downloaded.
# These are download counts, not distinct people: a repeated or retried
# download counts twice.
#
# Requires the GitHub CLI (`gh`) and `jq`, installed and authenticated:
#   brew install gh jq && gh auth login
#
# Usage: scripts/downloads.sh   (or: npm run downloads)

set -euo pipefail

REPO="caledavis/Magnolia"

for tool in gh jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found. Install with: brew install $tool" >&2
    exit 1
  fi
done

gh api "repos/${REPO}/releases/latest" \
  --jq '.tag_name as $t | .assets[] | [$t, .name, .download_count] | @tsv' \
  | awk -F'\t' '
  { tag = $1 }
  $2 ~ /\.(dmg|zip|app\.tar\.gz)$/   { mac += $3 }
  $2 ~ /\.exe$/                      { win += $3 }
  $2 ~ /\.(deb|rpm|AppImage)$/       { lin += $3 }
  END {
    printf "Downloads of %s\n", tag
    printf "  %-10s %6d\n", "macOS",   mac
    printf "  %-10s %6d\n", "Windows", win
    printf "  %-10s %6d\n", "Linux",   lin
    printf "  %-10s %6d\n", "Total",   mac + win + lin
  }'
