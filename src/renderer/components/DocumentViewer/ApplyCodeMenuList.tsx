/**
 * The codes listed under "Apply Code" in a selection's context menu,
 * shared by every viewer (text, PDF, image, transcript, survey).
 *
 * Every code is listed, in Code Browser order and indented by depth,
 * with its hotkey (if it has one) on the right. A long codebook scrolls
 * inside the menu (install-context-menu-clamp keeps the menu on screen).
 */
import { useTranslation } from 'react-i18next'
import type { Code } from '../../models/types'
import { modKey } from '../../utils/platform'

// Row spacing matches the Code Browser's rows.
const INDENT_PX = 16

export function ApplyCodeMenuList({ codes, onApply, itemTitle }: {
  /** The code tree flattened depth-first. */
  codes: { code: Code; depth: number }[]
  onApply: (codeGuid: string) => void
  itemTitle?: string
}) {
  const { t } = useTranslation()

  if (codes.length === 0) {
    return (
      <div className="context-menu-item" style={{ color: 'var(--menu-fg-muted)', pointerEvents: 'none' }}>
        {t('codes.empty')}
      </div>
    )
  }

  return (
    <div style={{ maxHeight: 'max(160px, 45vh)', overflowY: 'auto' }}>
      {codes.map(({ code, depth }) => (
        <div
          key={code.guid}
          className="context-menu-item"
          title={itemTitle}
          style={{ paddingBlock: 3, paddingInlineStart: 14 + depth * INDENT_PX, gap: 6 }}
          onClick={() => onApply(code.guid)}
        >
          <span className="color-pip" style={{ background: code.color || '#888' }} />
          <span style={{ flex: 1 }}>{code.name}</span>
          {code.hotkey !== undefined && (
            <span style={{ fontSize: 10, color: 'var(--menu-fg-muted)', marginInlineStart: 12 }}>{modKey(code.hotkey)}</span>
          )}
        </div>
      ))}
    </div>
  )
}
