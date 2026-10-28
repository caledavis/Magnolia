/**
 * Helpers for the renderer side of the `magnolia-bin://` binary-handle
 * lifecycle (see crates/magnolia-core/src/binary_store.rs for the resolver).
 *
 * A freshly-imported media binary (audio / video / image / PDF) is held in the
 * main process as a transient `overlay://<token>.<ext>` handle. Once a save
 * embeds it into the open .qdpx as `sources/<guid>.<ext>`, that overlay is
 * gone — so the renderer must stop referencing it by the volatile overlay
 * handle and switch to the durable `archive://<guid>.<ext>` handle, which
 * resolves straight from the archive on disk. `promotedArchiveHandle` computes
 * that durable handle (matching writer.ts's filename) for a saved source.
 */

const PREFIX = 'magnolia-bin://'
export const OVERLAY_PREFIX = `${PREFIX}overlay/`
export const ARCHIVE_PREFIX = `${PREFIX}archive/`

export function isOverlayHandle(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(OVERLAY_PREFIX)
}

/** The formatData field a media source stores its binary handle in, or null
 *  for non-binary source types. */
export function mediaPathField(
  sourceType: string | undefined
): 'pdfFilePath' | 'imageFilePath' | 'audioFilePath' | 'videoFilePath' | null {
  switch (sourceType) {
    case 'pdf': return 'pdfFilePath'
    case 'image': return 'imageFilePath'
    case 'audio': return 'audioFilePath'
    case 'video': return 'videoFilePath'
    default: return null
  }
}

/**
 * If a source's media binary is currently held as a transient overlay handle,
 * return the durable archive handle it becomes once a save embeds it into the
 * .qdpx as `sources/<guid>.<ext>`. The extension mirrors writer.ts exactly
 * (pdf → "pdf"; image → imageExt; audio → audioExt; video → videoExt), falling
 * back to the extension already encoded in the overlay handle. Returns null
 * when there's nothing to promote.
 */
export function promotedArchiveHandle(source: any): string | null {
  const field = mediaPathField(source?.sourceType)
  if (!field) return null
  const fd = source.formatData
  const handle = fd?.[field]
  if (!isOverlayHandle(handle)) return null
  const overlayExt = handle.slice(handle.lastIndexOf('.') + 1)
  const ext =
    source.sourceType === 'pdf'
      ? 'pdf'
      : source.sourceType === 'image'
        ? (fd.imageExt || overlayExt || 'png')
        : source.sourceType === 'audio'
          ? (fd.audioExt || overlayExt || 'audio')
          : (fd.videoExt || overlayExt || 'mp4')
  return `${ARCHIVE_PREFIX}${source.guid}.${ext}`
}
