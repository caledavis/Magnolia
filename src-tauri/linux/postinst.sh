#!/bin/sh
# Runs after the .deb or .rpm installs or upgrades Magnolia.
#
# Magnolia 1.x (Electron) registered /usr/bin/magnolia with
# update-alternatives, pointing at /opt/Magnolia/magnolia. Its removal script
# passed the link instead of the target (`--remove magnolia /usr/bin/magnolia`),
# so the registration outlives it, pointing at a folder the upgrade deleted.
# Remove it here. /usr/bin/magnolia is now this package's own binary, not a
# symlink, and neither Debian's nor Fedora's update-alternatives deletes a
# master link that isn't a symlink. Does nothing on a fresh install.

if command -v update-alternatives >/dev/null 2>&1 && [ ! -e /opt/Magnolia/magnolia ]; then
    update-alternatives --remove magnolia /opt/Magnolia/magnolia >/dev/null 2>&1 || true
fi

exit 0
