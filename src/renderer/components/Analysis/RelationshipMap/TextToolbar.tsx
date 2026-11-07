import type { Editor } from '@tiptap/react'
import { Icon, faBold, faItalic, faUnderline, faHeading1, faHeading2 } from '../../Icon'
import { useTranslation } from 'react-i18next'

interface Props {
  editor: Editor | null
}

const FONT_SIZES = [12, 14, 16, 20, 24, 32]

const COLORS = [
  '#1d1d1f', '#6b7280', '#ef4444', '#f59e0b',
  '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'
]

function ToolbarButton({
  active,
  onClick,
  children,
  title
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '3px 8px',
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        background: active ? 'var(--accent-bg, #e0e7ff)' : 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        color: active ? 'var(--accent-color, #3b82f6)' : 'var(--text-primary, #1d1d1f)',
        lineHeight: '20px'
      }}
    >
      {children}
    </button>
  )
}

export function TextToolbar({ editor }: Props) {
  const { t } = useTranslation()
  if (!editor) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 8px',
        background: 'var(--bg-primary, #fff)',
        border: '1px solid var(--border-color, #e0e0e0)',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        flexWrap: 'wrap'
      }}
    >
      {/* Headings */}
      <ToolbarButton
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title={t('editor.heading1')}
      >
        <Icon icon={faHeading1} style={{ fontSize: 14 }} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title={t('editor.heading2')}
      >
        <Icon icon={faHeading2} style={{ fontSize: 14 }} />
      </ToolbarButton>

      <div style={{ width: 1, height: 20, background: 'var(--border-color, #e0e0e0)', margin: '0 4px' }} />

      {/* Inline formatting */}
      <ToolbarButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title={t('editor.bold')}
      >
        <Icon icon={faBold} style={{ fontSize: 14 }} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title={t('editor.italic')}
      >
        <Icon icon={faItalic} style={{ fontSize: 14 }} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title={t('editor.underline')}
      >
        <Icon icon={faUnderline} style={{ fontSize: 14 }} />
      </ToolbarButton>

      <div style={{ width: 1, height: 20, background: 'var(--border-color, #e0e0e0)', margin: '0 4px' }} />

      {/* Font size */}
      <select
        value=""
        onChange={(e) => {
          const size = e.target.value
          if (size) {
            editor.chain().focus().setMark('textStyle', { fontSize: `${size}px` }).run()
          }
        }}
        style={{
          padding: '2px 4px',
          fontSize: 11,
          border: '1px solid var(--border-color, #d0d0d0)',
          borderRadius: 4,
          background: 'var(--bg-primary, #fff)',
          color: 'var(--text-primary, #1d1d1f)',
          cursor: 'pointer'
        }}
      >
        <option value="">{t('editor.size')}</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}px
          </option>
        ))}
      </select>

      <div style={{ width: 1, height: 20, background: 'var(--border-color, #e0e0e0)', margin: '0 4px' }} />

      {/* Color swatches */}
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => editor.chain().focus().setColor(c).run()}
          title={c}
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: c,
            border: '1px solid rgba(0,0,0,0.15)',
            cursor: 'pointer',
            padding: 0
          }}
        />
      ))}
    </div>
  )
}
