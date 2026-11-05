#!/usr/bin/env bash
# Report GitHub release download counts for Magnolia, summed over every release.
#
# 1. Auto-updater pings: how often installed copies checked for an update
#    (downloads of the update manifests). Magnolia 1.x polls one manifest per
#    OS (latest-mac.yml / latest.yml / latest-linux.yml); Magnolia 2.x polls a
#    single latest.json for every OS, so its pings can't be split by OS.
#    GitHub counts per release, so the "current" column only covers the time
#    since the latest release was published.
#
# 2. New downloads: installer downloads (.dmg; .exe; .deb / .rpm / .AppImage).
#    The Mac update payloads (.zip, .app.tar.gz) are left out, so the macOS
#    figure is installs only. On Windows and Linux the updater downloads the
#    same .exe / .AppImage a new user does, so those figures (marked *) also
#    include some updates.
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

latest_tag="$(gh api "repos/${REPO}/releases/latest" --jq '.tag_name')"

# One line per asset: tag, name, count.
gh api "repos/${REPO}/releases" --paginate \
  --jq '.[] | select(.draft | not) | .tag_name as $t | .assets[] | [$t, .name, .download_count] | @tsv' \
  | awk -F'\t' -v cur="$latest_tag" '
  function add(key, n) { all[key] += n; if ($1 == cur) now[key] += n }
  $2 == "latest-mac.yml"   { add("ping_mac", $3) }
  $2 == "latest.yml"       { add("ping_win", $3) }
  $2 == "latest-linux.yml" { add("ping_lin", $3) }
  $2 == "latest.json"      { add("ping_any", $3) }
  $2 ~ /\.dmg$/                    { add("new_mac", $3) }
  $2 ~ /\.exe$/                    { add("new_win", $3) }
  $2 ~ /\.(deb|rpm|AppImage)$/     { add("new_lin", $3) }
  function row(label, key) { printf "  %-22s %9d %12d\n", label, all[key], now[key] }
  function total(prefix,   k, a, n) {
    for (k in all) if (index(k, prefix) == 1) { a += all[k]; n += now[k] }
    printf "  %-22s %9d %12d\n", "Total", a, n
  }
  END {
    printf "Auto-updater pings       %9s %12s\n", "All time", "Since " cur
    row("macOS (1.x)",       "ping_mac")
    row("Windows (1.x)",     "ping_win")
    row("Linux (1.x)",       "ping_lin")
    row("Any OS (2.x)",      "ping_any")
    total("ping_")
    print ""
    printf "New downloads            %9s %12s\n", "All time", "Since " cur
    row("macOS",             "new_mac")
    row("Windows *",         "new_win")
    row("Linux *",           "new_lin")
    total("new_")
    print ""
    print "  * includes updater downloads of the same file"
  }'
