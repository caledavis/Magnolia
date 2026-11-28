#!/usr/bin/env bash
# Collects the source code of every library the Linux AppImage bundles,
# into one archive published beside it on the release, as the GPL and LGPL
# ask of anyone who distributes their libraries' binaries (GPLv2 §3: source
# offered from the same place as the binary counts as distributing it).
#
#   scripts/collect-appimage-sources.sh <AppDir> <output.tar>
#
# Run on the machine that built the AppImage, just after building it (the
# Release (Linux) workflow does): the versions must be the ones installed.
#
# Which libraries: linuxdeploy (and scripts/stage-appimage-gstreamer.mjs, for
# the GStreamer plugins) put each bundled package's copyright notice in the
# AppDir at usr/share/doc/<package>/, so those folders name every Debian or
# Ubuntu binary package the AppImage took files from. Each is mapped to its
# source package and exact installed version, which apt-get downloads (the
# deb-src lines must be enabled); a version the mirror no longer carries
# comes from Launchpad (pull-lp-source, in ubuntu-dev-tools) or, on Debian,
# snapshot.debian.org (pull-debian-source), if installed.
# Fails if any source can't be found, rather than publishing an incomplete
# set.
set -euo pipefail

appdir=$(realpath "$1")
out=$(realpath -m "$2")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/sources"

declare -A sources=()   # "source=version" → the binary packages it built
for doc in "$appdir"/usr/share/doc/*/; do
  pkg=$(basename "$doc")
  found=$(dpkg-query -W -f='${source:Package}=${source:Version}\n' "$pkg" 2>/dev/null | sort -u || true)
  if [ -z "$found" ]; then
    echo "::error::$pkg is bundled but isn't an installed package, so its source can't be found" >&2
    exit 1
  fi
  while read -r src; do sources[$src]+="$pkg "; done <<< "$found"
done
echo "${#sources[@]} source packages for $(ls -d "$appdir"/usr/share/doc/*/ | wc -l) bundled binary packages"

missing=()
cd "$work/sources"
for src in $(printf '%s\n' "${!sources[@]}" | sort); do
  name=${src%%=*} version=${src#*=}
  if apt-get source --download-only --quiet "$src" > /dev/null 2>&1; then
    continue
  fi
  if command -v pull-lp-source > /dev/null && pull-lp-source --download-only "$name" "$version" > /dev/null 2>&1; then
    continue
  fi
  # The same from snapshot.debian.org, when building on Debian.
  if command -v pull-debian-source > /dev/null && pull-debian-source --download-only "$name" "$version" > /dev/null 2>&1; then
    continue
  fi
  missing+=("$src")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::No source found for: ${missing[*]}" >&2
  exit 1
fi

{
  echo "The source code of the libraries in Magnolia's Linux AppImage."
  echo
  echo "These are Debian/Ubuntu source packages, exactly as the distribution"
  echo "publishes them: for each, the upstream code (.orig.tar.*), the"
  echo "distribution's changes (.debian.tar.* or .diff.gz) and a description"
  echo "of them (.dsc). \`dpkg-source -x <name>.dsc\` unpacks one."
  echo "Licences: see each package's debian/copyright, and"
  echo "usr/share/common-licenses in the AppImage."
  echo
  echo "Source package = version: the bundled binary packages built from it"
  echo
  for src in $(printf '%s\n' "${!sources[@]}" | sort); do
    echo "$src: ${sources[$src]% }"
  done
} > "$work/sources/MANIFEST.txt"

tar -cf "$out" -C "$work" sources
echo "Wrote $out ($(du -h "$out" | cut -f1))"
