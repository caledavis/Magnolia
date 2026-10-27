/**
 * Format Registry — single source of truth for all document formats.
 */
import type { SourceType } from '../models/types'

export interface InlineRange {
  cpStart: number
  cpEnd: number
  style: React.CSSProperties
  hidden?: boolean
}

export interface LineAnnotation {
  blockClass: string
  inline: InlineRange[]
}

export interface FormatDef {
  sourceType: SourceType
  label: string
  extensions: string[]
  /**
   * Parse the full document text and return per-line annotations.
   * Returns null for plain text (no formatting).
   */
  parseDocument: (text: string) => LineAnnotation[] | null
}

import { plainTextFormat } from './formats/plain-text-format'
import { markdownFormat, noteFormat } from './formats/markdown-format'
import { pdfFormat } from './formats/pdf-format'
import { audioFormat } from './formats/audio-format'
import { imageFormat } from './formats/image-format'
import { videoFormat } from './formats/video-format'

const ALL_FORMATS: FormatDef[] = [
  plainTextFormat,
  markdownFormat,
  noteFormat,
  pdfFormat,
  audioFormat,
  imageFormat,
  videoFormat,
]

const FORMAT_MAP = new Map<string, FormatDef>(
  ALL_FORMATS.map((f) => [f.sourceType, f])
)

export function getFormat(sourceType?: string): FormatDef {
  return FORMAT_MAP.get(sourceType || 'text') || plainTextFormat
}

export function allImportExtensions(): string[] {
  return [...ALL_FORMATS.flatMap((f) => f.extensions), 'docx', 'rtf', 'odt', 'doc']
}

export function importFilterLabel(): string {
  return ALL_FORMATS.filter((f) => f.extensions.length > 0).map((f) => f.label).join(' & ') + ' & Word / RTF / ODT Documents'
}

// Extensions that are converted to PDF on import (treated as PDF in the
// viewer). Legacy .doc is also listed — the main-process reader catches
// it and returns a readable "save as .docx first" error, instead of
// letting the file picker silently refuse.
const CONVERTED_TO_PDF = new Set(['docx', 'rtf', 'odt', 'doc'])

export function sourceTypeFromExtension(ext: string): SourceType {
  const lower = ext.toLowerCase()
  if (CONVERTED_TO_PDF.has(lower)) return 'pdf'
  for (const f of ALL_FORMATS) {
    if (f.extensions.includes(lower)) return f.sourceType
  }
  return 'text'
}

export function sourceTypeFromFilename(filename: string): SourceType {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return sourceTypeFromExtension(ext)
}
