/**
 * PdfRegionThumbnail — renders a cropped image preview of a rectangular
 * box region from either a PDF page or an image source. Used by the Saved
 * Quotes and Query Results panes to visualize box selections that have no
 * text content on their own.
 *
 * Despite the historical name, this component dispatches by the source's
 * sourceType: image regions are cropped from the image bitmap, PDF
 * regions are rasterised from the page.
 */
import { useEffect, useRef, useState } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { renderPdfRegionThumbnail } from '../../utils/pdf-thumbnail'
import { renderImageRegionThumbnail } from '../../utils/image-thumbnail'
import { sourceTypeFromFilename } from '../../utils/format-registry'

interface Props {
  /** Source document GUID — used to look up the PDF / image file path
   *  and source type when `filePath` is not explicitly provided. */
  sourceGuid: string
  /** Optional direct file path override. Used by popped-out windows
   *  where the document store doesn't carry formatData for sources. */
  filePath?: string
  /** 1-based page number. Always 1 for image sources. */
  page: number
  /** Region in PDF user-space points (PDF) or image pixels (image),
   *  top-origin. */
  x: number
  y: number
  width: number
  height: number
  /** Display-size cap (pixels). The image fits inside this box while
   *  preserving aspect ratio. Defaults to 240×160. */
  maxW?: number
  maxH?: number
}

export function PdfRegionThumbnail({ sourceGuid, filePath: filePathProp, page, x, y, width, height, maxW = 240, maxH = 160 }: Props) {
  const source = useDocumentStore((s) => s.sources.find((src) => src.guid === sourceGuid))
  const formatData = (source as any)?.formatData
  const filePath =
    filePathProp ??
    (formatData?.imageFilePath as string | undefined) ??
    (formatData?.pdfFilePath as string | undefined)
  // Freshly-imported PDFs carry their bytes inline (formatData.pdfBase64)
  // rather than a file path. Fall back to that so quote thumbnails work
  // before the project has been saved/reloaded — otherwise the renderer
  // can't find the PDF and shows "PDF file not available".
  const pdfBase64 = (formatData?.pdfBase64 as string | undefined)
  // Source type may be unknown in popped-out windows where the document
  // store isn't populated. Fall back to inferring from the file path.
  const isImage = (source as any)?.sourceType
    ? (source as any).sourceType === 'image'
    : !!filePath && sourceTypeFromFilename(filePath) === 'image'

  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Only rasterise once the thumbnail is near the viewport. A query over a
  // large PDF project can list hundreds of box results; rendering them all
  // up front loads every PDF they touch at once. Latches true — once seen,
  // a thumbnail keeps its image when scrolled away.
  const placeholderRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  useEffect(() => {
    if (nearViewport) return
    const el = placeholderRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [nearViewport])

  useEffect(() => {
    if (!nearViewport) return
    if (!filePath && !pdfBase64) {
      setError(isImage ? 'Image file not available' : 'PDF file not available')
      return
    }
    let cancelled = false
    setError(null)
    setDataUrl(null)
    const promise = isImage
      ? renderImageRegionThumbnail({ filePath: filePath as string, x, y, width, height })
      : renderPdfRegionThumbnail(
          filePath
            ? { filePath, page, x, y, width, height }
            : { pdfBase64: pdfBase64 as string, docKey: sourceGuid, page, x, y, width, height }
        )
    promise
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message || err))
      })
    return () => {
      cancelled = true
    }
  }, [nearViewport, filePath, pdfBase64, sourceGuid, isImage, page, x, y, width, height])

  // Keep aspect ratio while fitting inside maxW × maxH.
  const aspect = width > 0 && height > 0 ? width / height : 1
  let displayW = maxW
  let displayH = Math.round(maxW / aspect)
  if (displayH > maxH) {
    displayH = maxH
    displayW = Math.round(maxH * aspect)
  }

  const containerStyle: React.CSSProperties = {
    width: displayW,
    height: displayH,
    flexShrink: 0,
    border: '1px solid var(--border-color)',
    borderRadius: 3,
    overflow: 'hidden',
    background: 'var(--bg-tertiary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }

  if (error) {
    return (
      <div style={{ ...containerStyle, fontSize: 10, color: 'var(--text-muted)', padding: 8, textAlign: 'center' }}>
        {error}
      </div>
    )
  }
  if (!dataUrl) {
    return (
      <div ref={placeholderRef} style={containerStyle}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Rendering…</div>
      </div>
    )
  }
  return (
    <div style={containerStyle}>
      <img
        src={dataUrl}
        alt={`Page ${page} region`}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        draggable={false}
      />
    </div>
  )
}
