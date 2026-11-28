import { v4 as uuidv4 } from 'uuid'

/**
 * GUIDs are uppercase end-to-end in Magnolia. Rationale:
 *
 *   - The QDA-XML 1.0 schema (Atlas.ti / MAXQDA) requires uppercase hex
 *     for GUID attributes, so the on-disk format must be uppercase.
 *   - Keeping renderer state, the magnolia-* JSON side-tables, the
 *     sources/<guid>.<ext> filenames, and the XML attributes all in
 *     the same case removes a class of bug where one path normalises
 *     and another doesn't, then guid lookups silently miss.
 */
export function generateGuid(): string {
  return uuidv4().toUpperCase()
}
