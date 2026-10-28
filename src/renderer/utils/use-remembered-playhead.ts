/**
 * useRememberedPlayhead — remembers where playback was in an audio or video
 * document and returns there when its media loads again, including after
 * the project is reopened (see view-position-store.ts).
 *
 * Call `restore` from the media element's onLoadedMetadata and `save` from
 * its onTimeUpdate and onPause. A jump to a coded clip seeks after this
 * restore (its own loadedmetadata listener runs later), so it still wins.
 *
 * Saving waits until this document's media has loaded and been restored:
 * the viewers reuse one element across documents, and its events for the
 * outgoing media, or the new media sitting at 0, must not overwrite the
 * new document's saved time.
 */
import { useCallback, useRef, type RefObject } from 'react'
import { getViewSetting, setViewSetting } from '../stores/view-position-store'

/** Saved within this many seconds of the end, playback starts over instead. */
const END_MARGIN_S = 1

export function useRememberedPlayhead(
  sourceGuid: string,
  mediaRef: RefObject<HTMLMediaElement | null>
): { restore: () => void; save: () => void } {
  const restoredGuidRef = useRef<string | null>(null)
  const key = `${sourceGuid}|time`

  const restore = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    restoredGuidRef.current = sourceGuid
    const saved = Number(getViewSetting(key))
    if (saved > 0 && (!Number.isFinite(media.duration) || saved < media.duration - END_MARGIN_S)) {
      media.currentTime = saved
    }
  }, [key, sourceGuid, mediaRef])

  const save = useCallback(() => {
    const media = mediaRef.current
    if (!media || restoredGuidRef.current !== sourceGuid) return
    setViewSetting(key, media.currentTime.toFixed(2))
  }, [key, sourceGuid, mediaRef])

  return { restore, save }
}
