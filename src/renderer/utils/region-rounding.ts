/**
 * Rounds a freshly-drawn box-coding region to the same whole-pixel corners
 * the .qdpx writer will round it to on save (src/main/qdpx/xml-serializer.ts's
 * serializePictureSelection/serializePdfSelection — REFI-QDA's
 * PictureSelection/PDFSelection coordinates are xs:integer, so raw floats
 * from mouse/zoom math get rounded at export regardless).
 *
 * Without this, a region created from live mouse coordinates keeps its
 * exact fractional x/y/width/height in memory for the rest of the
 * session, while any copy reloaded from disk has already been rounded —
 * two representations of the same coding that never compare equal. The
 * merge tool's anchor-matching (project-diff.ts's anchorKey, keyed
 * directly off these fields) is the one place this bites hardest: a
 * coding that's been saved successfully still shows up as "unsaved" on
 * every subsequent reconcile, because its in-memory anchor key never
 * matches the reloaded one.
 *
 * Rounds x and the opposite corner (x+width) independently, then derives
 * width from the rounded corners — matching the writer's own
 * `Math.round(r.x)` / `Math.round(r.x + r.width)` exactly, not just
 * rounding width on its own, which would round to a different pixel
 * boundary than the writer does. Idempotent: rounding an already-rounded
 * region returns it unchanged, so calling this once at creation time
 * keeps the in-memory and round-tripped-through-disk values identical
 * for the region's entire lifetime.
 */
export function roundRegionToWholePixels(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  const rx = Math.round(x)
  const ry = Math.round(y)
  return {
    x: rx,
    y: ry,
    width: Math.round(x + width) - rx,
    height: Math.round(y + height) - ry
  }
}
