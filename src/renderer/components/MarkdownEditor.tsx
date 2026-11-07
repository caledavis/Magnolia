import { useEditor, EditorContent, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
// Underline is bundled by StarterKit in TipTap v3 — importing it
// separately triggers a "Duplicate extension names" warning and
// destabilises the editor (see FreeTextNode for the same fix).
import { Markdown } from 'tiptap-markdown'
import { useEffect, useCallback, useMemo, useRef } from 'react'
import { Icon, faBold, faItalic, faUnderline, faListUl, faListOl, faHeading1, faHeading2 } from './Icon'
import { useTranslation } from 'react-i18next'

interface Props {
  value: string
  onChange: (markdown: string) => void
  autoFocus?: boolean
  style?: React.CSSProperties
  /** Called on Enter. Return text to prepend to the new line, or null for default behavior. */
  onEnterKey?: () => string | null
  /** Show the H1 / H2 heading buttons. Default true; pass false where
   *  headings aren't wanted (e.g. report Text blocks). */
  headings?: boolean
}

function ToolbarButton({
  active,
  onClick,
  title,
  children
}: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault() // keep editor focus
        onClick()
      }}
      title={title}
      style={{
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--text-secondary)',
        border: 'none',
        borderRadius: 3,
        width: 26,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1,
        padding: 0,
        flexShrink: 0
      }}
    >
      {children}
    </button>
  )
}

/**
 * A WYSIWYG editor that stores content as Markdown.
 * Typing produces rich text immediately; the value prop and onChange
 * callback use plain markdown strings.
 */
export function MarkdownEditor({ value, onChange, autoFocus, style, onEnterKey, headings = true }: Props) {
  const { t } = useTranslation()
  const onEnterKeyRef = useRef(onEnterKey)
  onEnterKeyRef.current = onEnterKey

  // Custom extension to intercept Enter and insert prefix text (e.g. timestamp)
  const enterExtension = useMemo(() => {
    if (!onEnterKey) return null
    return Extension.create({
      name: 'enterPrefix',
      addKeyboardShortcuts() {
        return {
          Enter: ({ editor }) => {
            const prefix = onEnterKeyRef.current?.() ?? null
            if (prefix) {
              editor.chain().splitBlock().insertContent(prefix + ' ').run()
              return true
            }
            return false
          }
        }
      }
    })
  }, [!!onEnterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const extensions = useMemo(() => {
    const exts: any[] = [StarterKit, Markdown]
    if (enterExtension) exts.push(enterExtension)
    return exts
  }, [enterExtension])

  const editor = useEditor({
    extensions,
    content: value,
    onUpdate: ({ editor }) => {
      onChange((editor.storage as any).markdown.getMarkdown())
    }
  })

  // Focus on mount if requested
  useEffect(() => {
    if (autoFocus && editor) {
      setTimeout(() => editor.commands.focus('end'), 50)
    }
  }, [autoFocus, editor])

  const toggle = useCallback((cmd: () => void) => {
    cmd()
    editor?.commands.focus()
  }, [editor])

  return (
    <div
      className="markdown-editor"
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-sm)',
        ...style
      }}
    >
      {/* Formatting toolbar */}
      {editor && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '3px 6px',
            borderBottom: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
            flexWrap: 'wrap'
          }}
        >
          {/* Headings */}
          {headings && (
            <>
              <ToolbarButton
                active={editor.isActive('heading', { level: 1 })}
                onClick={() => toggle(() => editor.chain().toggleHeading({ level: 1 }).run())}
                title={t('editor.heading1')}
              >
                <Icon icon={faHeading1} style={{ fontSize: 14 }} />
              </ToolbarButton>
              <ToolbarButton
                active={editor.isActive('heading', { level: 2 })}
                onClick={() => toggle(() => editor.chain().toggleHeading({ level: 2 }).run())}
                title={t('editor.heading2')}
              >
                <Icon icon={faHeading2} style={{ fontSize: 14 }} />
              </ToolbarButton>

              <div style={{ width: 1, height: 16, background: 'var(--border-color)', margin: '0 3px', flexShrink: 0 }} />
            </>
          )}

          {/* Inline formatting */}
          <ToolbarButton
            active={editor.isActive('bold')}
            onClick={() => toggle(() => editor.chain().toggleBold().run())}
            title={t('editor.bold')}
          >
            <Icon icon={faBold} style={{ fontSize: 14 }} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('italic')}
            onClick={() => toggle(() => editor.chain().toggleItalic().run())}
            title={t('editor.italic')}
          >
            <Icon icon={faItalic} style={{ fontSize: 14 }} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('underline')}
            onClick={() => toggle(() => editor.chain().toggleUnderline().run())}
            title={t('editor.underline')}
          >
            <Icon icon={faUnderline} style={{ fontSize: 14 }} />
          </ToolbarButton>

          <div style={{ width: 1, height: 16, background: 'var(--border-color)', margin: '0 3px', flexShrink: 0 }} />

          {/* Lists */}
          <ToolbarButton
            active={editor.isActive('bulletList')}
            onClick={() => toggle(() => editor.chain().toggleBulletList().run())}
            title={t('editor.bulletList')}
          >
            <Icon icon={faListUl} style={{ fontSize: 14 }} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('orderedList')}
            onClick={() => toggle(() => editor.chain().toggleOrderedList().run())}
            title={t('editor.numberedList')}
          >
            <Icon icon={faListOl} style={{ fontSize: 14 }} />
          </ToolbarButton>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
