"""Check that an extracted AppImage can play audio and video.

WebKitGTK plays media through GStreamer. An AppImage built without
bundleMediaFramework carries GStreamer's core libraries but none of its
plugins, so it borrows the user's, and a newer distro's plugins don't load
into the older core ("undefined symbol"): nothing plays at all. This loads
the AppImage's own GStreamer, with the plugin path its AppRun hook sets,
and asks for the elements Magnolia's players need.

Usage (after `Magnolia.AppImage --appimage-extract`):
    . squashfs-root/apprun-hooks/linuxdeploy-plugin-gstreamer.sh
    python3 -I scripts/check-appimage-media.py squashfs-root
"""

import ctypes
import sys
from pathlib import Path

# Demuxers, parsers and decoders for the formats Magnolia imports (MP4/MOV
# with H.264 and AAC, as phones and Zoom record; WebM; MP3; WAV), the
# playback bin WebKit builds on, and audio output.
NEEDED = [
    "playbin", "decodebin", "uridecodebin",
    "qtdemux", "matroskademux", "h264parse", "aacparse", "mpegaudioparse", "wavparse",
    "avdec_h264", "avdec_aac", "mpg123audiodec", "vp8dec", "vp9dec", "opusdec", "vorbisdec",
    "audioconvert", "audioresample", "videoconvert", "autoaudiosink",
]


def main() -> int:
    root = Path(sys.argv[1])
    gst = ctypes.CDLL(str(root / "usr/lib/libgstreamer-1.0.so.0"))
    gst.gst_init(None, None)
    v = (ctypes.c_uint * 4)()
    gst.gst_version(*(ctypes.byref(v, 4 * i) for i in range(4)))
    print(f"GStreamer {v[0]}.{v[1]}.{v[2]}")
    gst.gst_element_factory_find.restype = ctypes.c_void_p
    gst.gst_element_factory_find.argtypes = [ctypes.c_char_p]
    missing = [name for name in NEEDED if not gst.gst_element_factory_find(name.encode())]
    if missing:
        print("Missing GStreamer elements: " + ", ".join(missing))
        return 1
    print(f"All {len(NEEDED)} media elements found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
